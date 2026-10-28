/**
 * Pending-row verifier ("the indexer"). Tips, badge burns and .wif claims/sales are recorded with a tx hash as
 * pending (verified = 0 / minted = 0). This reads the mined receipt (or ownerOf for names) and only then flips the row:
 *   tips        -> Wifly Tipped(from, creator, postId, amount) with from = one of the tipper's wallets, creator = one of
 *                  the author's wallets, postId = keccak256("post:<dropId>") (0x00… for chat and profile tips), amount = the recorded amount. Adds to drops.tip_total.
 *   badge_burns -> WiflyBadges BurnedForBadges(user, amount) with user = one of the burner's wallets.
 *   names       -> WiflyNames.ownerOf (syncName) for unminted claims and pending sales.
 * Read-only: it never sends a transaction and needs no key. A hash that is reused, reverted or doesn't match stays pending.
 */
import { decodeEventLog, formatEther, keccak256, parseAbi, parseEther, toBytes, type Address, type Hex } from 'viem'
import { chainClient } from './chain'
import { badgesContract, namesContract, wiflyContract } from './config'
import { all, one, run, writeTx } from './db'
import { syncName } from './features'
import { reconcileAll, reconcileUser } from './reconcile'
import { uidForWallet, walletsOfUser } from './accounts'
import { payoutOf } from './proofs'
import { backfillTransfers, syncListings } from './market'
import { errLine } from './errline'

const WIFLY_EVENTS = parseAbi(['event Tipped(address indexed from, address indexed creator, bytes32 indexed postId, uint256 amount, uint256 fee)'])
const BADGE_EVENTS = parseAbi(['event BurnedForBadges(address indexed user, uint256 amount, uint256 totalBurnedByUser)'])
const DAY = 86400_000

const walletsOf = walletsOfUser // users.address, linked/guest wallets and the Privy embedded wallet
/** Matching events from a successful receipt (null = not mined yet, [] = reverted or none). */
async function eventsIn<A extends readonly unknown[]>(hash: string, contract: Address, abi: A) {
  const rc = await chainClient().getTransactionReceipt({ hash: hash as Hex }).catch(() => null)
  if (!rc) return null
  if (rc.status !== 'success') return []
  const out: { eventName: string; args: Record<string, unknown> }[] = []
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== contract.toLowerCase()) continue
    try { out.push(decodeEventLog({ abi: abi as never, data: l.data, topics: l.topics }) as never) } catch { /* other event */ }
  }
  return out
}
const wei = (n: number) => parseEther(String(n))

export async function verifyTip(id: number): Promise<boolean> {
  const W = wiflyContract(); if (!W) return false
  const t = await one<{ id: number; from_id: number; to_id: number; drop_id: string | null; amount: number; tx_hash: string | null; verified: number }>('SELECT * FROM tips WHERE id = ?', [id])
  if (!t || Number(t.verified) || !t.tx_hash) return false
  const hash = t.tx_hash.toLowerCase()
  if (await one('SELECT 1 FROM tips WHERE tx_hash = ? COLLATE NOCASE AND verified = 1', [hash])) return false // cheap early out; the UPDATE below is the real guard
  const ev = await eventsIn(hash, W, WIFLY_EVENTS); if (!ev) return false
  const [from, to] = await Promise.all([walletsOf(Number(t.from_id)), walletsOf(Number(t.to_id))])
  // the creator's tip destination (chosen + signed, or where their .wif resolves) counts, as does any wallet on their account
  const pay = (await payoutOf(Number(t.to_id))).address; if (pay) to.add(pay)
  // a tip from a chat or a profile carries no post (postId 0x00…)
  const postId = t.drop_id ? keccak256(toBytes(`post:${t.drop_id}`)).toLowerCase() : '0x' + '0'.repeat(64)
  const match = ev.find(e => e.eventName === 'Tipped' && from.has(String(e.args.from).toLowerCase()) && to.has(String(e.args.creator).toLowerCase())
    && String(e.args.postId).toLowerCase() === postId && e.args.amount === wei(Number(t.amount)))
  if (!match) return false
  const fee = Number(formatEther((match.args.fee as bigint) ?? 0n))
  // a chat tip says so in the notification (its bubble is posted before this runs)
  const dm = !t.drop_id && !!(await one(`SELECT 1 FROM dm_messages WHERE kind = 'tip' AND json_extract(meta, '$.tipId') = ?`, [id]).catch(() => null))
  // once-only: flip this row only if no row with the same hash is verified, and count it only if the flip happened.
  // The partial UNIQUE index tips_tx_verified backs this up; a lost race lands in the catch and counts nothing.
  // The "tipped you" notification goes out here and only here (never on the client's say-so), once per tx hash.
  return writeTx(async exec => {
    const u = await exec(`UPDATE tips SET verified = 1 WHERE id = ? AND verified = 0
      AND NOT EXISTS (SELECT 1 FROM tips WHERE tx_hash = ? COLLATE NOCASE AND verified = 1)`, [id, hash])
    if (u.rowsAffected !== 1) return false
    if (t.drop_id) await exec('UPDATE drops SET tip_total = tip_total + ? WHERE id = ?', [Number(t.amount), t.drop_id])
    await notifyTip(exec, { toId: Number(t.to_id), fromId: Number(t.from_id), dropId: t.drop_id, hash, gross: Number(t.amount), fee, when: Date.now(), extra: dm ? { dm: true } : {} })
    return true
  }).catch(() => false)
}

type Exec = Parameters<Parameters<typeof writeTx>[0]>[0]
/** The one "tipped you" notification for a verified tip. dkey 'tip:<hash>' + the unique index make it once per tx. */
async function notifyTip(exec: Exec, n: { toId: number; fromId: number; dropId: string | null; hash: string; gross: number; fee: number; when: number; extra: object }) {
  if (!n.toId || n.toId === n.fromId) return
  await exec(`INSERT INTO notifications (user_id, actor_id, kind, drop_id, meta, created_at, dkey) VALUES (?, ?, 'tip', ?, ?, ?, ?)
    ON CONFLICT DO NOTHING`, [n.toId, n.fromId || null, n.dropId, JSON.stringify({ amount: n.gross - n.fee, gross: n.gross, ...n.extra }), n.when, `tip:${n.hash}`])
}

/** Credited to whoever owns the burning wallet (BurnedForBadges.user), not to whoever shared the hash first.
 *  No known owner: stays pending for nobody's badge until that wallet's owner shows up (their POST or the sweep). */
export async function verifyBurn(txHash: string): Promise<boolean> {
  const B = badgesContract(); if (!B) return false
  const hash = txHash.toLowerCase()
  const r = await one<{ verified: number }>('SELECT verified FROM badge_burns WHERE tx_hash = ?', [hash])
  if (!r || Number(r.verified)) return false
  const ev = await eventsIn(hash, B, BADGE_EVENTS); if (!ev) return false
  for (const e of ev) {
    if (e.eventName !== 'BurnedForBadges') continue
    const w = String(e.args.user).toLowerCase()
    const owner = await one<{ id: number }>('SELECT id FROM users WHERE address = ? UNION SELECT user_id AS id FROM user_wallets WHERE address = ? LIMIT 1', [w, w])
    if (!owner) continue
    // record what the chain says was burned, once
    const ok = await writeTx(async exec => (await exec('UPDATE badge_burns SET verified = 1, user_id = ?, amount = ? WHERE tx_hash = ? AND verified = 0',
      [Number(owner.id), Number(e.args.amount as bigint) / 1e18, hash])).rowsAffected === 1).catch(() => false)
    return ok
  }
  return false
}

/** One pass over recent pending rows (last 3 days, capped). Safe to call often; every check is a read. */
let sweeping = false
export async function verifyPending(limit = 25) {
  if (sweeping) return 0 // a slow sweep never overlaps the next tick
  sweeping = true
  try { return await sweep(limit) } finally { sweeping = false }
}
async function sweep(limit: number) {
  const since = Date.now() - 3 * DAY
  let n = 0
  if (wiflyContract()) for (const t of await all<{ id: number }>('SELECT id FROM tips WHERE verified = 0 AND tx_hash IS NOT NULL AND created_at > ? ORDER BY id DESC LIMIT ?', [since, limit]))
    if (await verifyTip(Number(t.id)).catch(() => false)) n++
  if (wiflyContract()) n += await backfillTips().catch(e => { console.warn('[tips-backfill]', errLine(e, 80)); return 0 })
  if (badgesContract()) for (const b of await all<{ tx_hash: string }>('SELECT tx_hash FROM badge_burns WHERE verified = 0 AND created_at > ? ORDER BY created_at DESC LIMIT ?', [since, limit]))
    if (await verifyBurn(b.tx_hash).catch(() => false)) n++
  if (namesContract()) {
    const names = await all<{ name: string }>(`SELECT name FROM names WHERE minted = 0 AND created_at > ?
      UNION SELECT name FROM name_sales WHERE verified = 0 AND created_at > ? LIMIT ?`, [since, since, limit])
    for (const x of names) if ((await syncName(x.name, { onlyKnown: true }).catch(() => null))?.known) n++
    n += await backfillClaims().catch(e => { console.warn('[names-backfill]', errLine(e, 80)); return 0 })
    n += await backfillTransfers().catch(e => { console.warn('[names-transfers]', errLine(e, 80)); return 0 })
    n += await syncListings().catch(() => 0)
    n += (await reconcileAll({ light: true, limit: 200 }).catch(() => [])).length
  }
  return n
}

/**
 * claims the app never recorded (the claim call failed, or the wallet wasn't linked yet). Walks
 * WiflyNames.NameClaimed logs from a saved block cursor; a claim by a wallet that belongs to an account and has no
 * mirror row is synced from ownerOf. Read-only (eth_getLogs + eth_call).
 */
const CLAIMED = parseAbi(['event NameClaimed(uint256 indexed tokenId, string name, address indexed owner, uint256 fee)'])
const CHUNK = 50_000n
export async function backfillClaims(maxChunks = 8): Promise<number> {
  const N = namesContract(); if (!N) return 0
  const c = chainClient()
  const head = await c.getBlockNumber()
  const saved = await one<{ v: string }>("SELECT v FROM kv WHERE k = 'names:cursor'")
  let from = saved ? BigInt(saved.v) : head > BigInt(process.env.NAMES_BACKFILL_BLOCKS ?? 3_000_000) ? head - BigInt(process.env.NAMES_BACKFILL_BLOCKS ?? 3_000_000) : 0n
  let n = 0
  for (let i = 0; i < maxChunks && from <= head; i++) {
    const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head
    const logs = await c.getLogs({ address: N, event: CLAIMED[0], fromBlock: from, toBlock: to })
    for (const l of logs) {
      const name = String(l.args.name ?? '').toLowerCase().replace(/\.wif$/, ''), owner = String(l.args.owner ?? '')
      if (!name || await one('SELECT 1 FROM names WHERE name = ? AND minted = 1', [name])) continue
      if (!(await uidForWallet(owner))) continue
      if ((await syncName(name, { onlyKnown: true }).catch(() => null))?.known) n++
    }
    from = to + 1n
    await run("INSERT INTO kv (k, v) VALUES ('names:cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [String(from)])
  }
  return n
}
/**
 * Tips the app never recorded (the client call failed, or it came from outside the app): walks Wifly Tipped logs from a
 * saved block cursor. A tip to a wallet on an account with no verified row for that tx hash gets a verified tip row (the
 * log is the proof; a pending app row for the hash is settled in place) and one "tipped you" notification. The tipper is the account that owns `from`, or nobody (meta.from keeps a
 * short address). Deduped by tx hash + receiving account, so a tip the app already recorded (or one from a wallet no
 * account owns) never notifies twice. Read-only (eth_getLogs).
 */
const TIPPED = WIFLY_EVENTS[0]
const ZERO32 = '0x' + '0'.repeat(64)
export async function backfillTips(maxChunks = 8): Promise<number> {
  const W = wiflyContract(); if (!W) return 0
  const c = chainClient()
  const head = await c.getBlockNumber({ cacheTime: 0 })
  const look = BigInt(process.env.TIPS_BACKFILL_BLOCKS ?? 1_000_000)
  const saved = await one<{ v: string }>("SELECT v FROM kv WHERE k = 'tips:cursor'")
  let from = saved ? BigInt(saved.v) : head > look ? head - look : 0n
  let n = 0
  const times = new Map<bigint, number>()
  const at = async (b: bigint | null) => {
    if (b == null) return Date.now()
    if (!times.has(b)) times.set(b, await c.getBlock({ blockNumber: b }).then(x => Number(x.timestamp) * 1000).catch(() => Date.now()))
    return Math.min(times.get(b)!, Date.now())
  }
  for (let i = 0; i < maxChunks && from <= head; i++) {
    const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head
    const logs = await c.getLogs({ address: W, event: TIPPED, fromBlock: from, toBlock: to })
    for (const l of logs) {
      const hash = String(l.transactionHash ?? '').toLowerCase(); if (!/^0x[0-9a-f]{64}$/.test(hash)) continue
      const creator = String(l.args.creator ?? ''), sender = String(l.args.from ?? '')
      const toId = await uidForWallet(creator); if (!toId) continue
      const fromId = (await uidForWallet(sender)) ?? 0
      if (fromId === toId) continue
      // one tip per (tx hash, receiving account). Already verified (by the app or an earlier pass): skip. A pending row the
      // app filed for this hash is settled by the log instead (sender, amount and post come from the log, not the client),
      // so a tip paid from a wallet no account owns, or a hash someone else filed first, still ends as one row, one notification.
      const had = await one<{ id: number; verified: number }>('SELECT id, verified FROM tips WHERE tx_hash = ? AND to_id = ? ORDER BY verified DESC, id LIMIT 1', [hash, toId])
      if (had && Number(had.verified)) continue
      const gross = Number(formatEther((l.args.amount as bigint) ?? 0n)), fee = Number(formatEther((l.args.fee as bigint) ?? 0n))
      if (!(gross > 0)) continue
      const postId = String(l.args.postId ?? ZERO32).toLowerCase()
      let dropId: string | null = null
      if (postId !== ZERO32) {
        const mine = await all<{ id: string }>('SELECT id FROM drops WHERE author_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 500', [toId])
        dropId = mine.find(d => keccak256(toBytes(`post:${d.id}`)).toLowerCase() === postId)?.id ?? null
      }
      const when = await at(l.blockNumber ?? null)
      const dm = !!had && !dropId && !!(await one(`SELECT 1 FROM dm_messages WHERE kind = 'tip' AND json_extract(meta, '$.tipId') = ?`, [Number(had.id)]).catch(() => null))
      const ok = await writeTx(async exec => {
        const r = had
          ? await exec(`UPDATE tips SET verified = 1, from_id = ?, drop_id = ?, amount = ? WHERE id = ? AND verified = 0
              AND NOT EXISTS (SELECT 1 FROM tips WHERE tx_hash = ? COLLATE NOCASE AND verified = 1)`, [fromId, dropId, gross, Number(had.id), hash])
          : await exec(`INSERT INTO tips (from_id, to_id, drop_id, amount, tx_hash, verified, created_at)
              SELECT ?, ?, ?, ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM tips WHERE tx_hash = ? COLLATE NOCASE AND verified = 1)`, [fromId, toId, dropId, gross, hash, when, hash])
        if (r.rowsAffected !== 1) return false
        if (dropId) await exec('UPDATE drops SET tip_total = tip_total + ? WHERE id = ?', [gross, dropId])
        await notifyTip(exec, { toId, fromId, dropId, hash, gross, fee, when, extra: { chain: true, ...(dm ? { dm: true } : {}), ...(fromId ? {} : { from: `${sender.slice(0, 6)}…${sender.slice(-4)}`.toLowerCase() }) } })
        return true
      }).catch(() => false)
      if (ok) n++
    }
    from = to + 1n
    await run("INSERT INTO kv (k, v) VALUES ('tips:cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [String(from)])
  }
  return n
}

/** A wallet was just linked: pick up any .wif it already holds (its primary onchain, plus the backfill walk). */
export async function adoptWalletNames(uid: number, address: string): Promise<void> {
  const N = namesContract(); if (!N) return
  const nm = await chainClient().readContract({ address: N, abi: parseAbi(['function reverseName(address) view returns (string)']), functionName: 'reverseName', args: [address as Address] }).catch(() => '')
  const label = String(nm || '').toLowerCase().replace(/\.wif$/, '')
  if (label) await syncName(label, { onlyKnown: true }).catch(() => null)
  for (const r of await all<{ name: string }>('SELECT name FROM names WHERE minted = 0 AND owner_id = ? LIMIT 8', [uid])) await syncName(r.name, { onlyKnown: true }).catch(() => null)
  await reconcileUser(uid).catch(() => null)
}

let timer: ReturnType<typeof setInterval> | null = null
/** Runs whenever any contract address is set. Read-only, so it needs no flag or key. */
export function startVerifier(intervalMs = Number(process.env.VERIFY_INTERVAL_MS ?? 60_000)) {
  if (timer || !(wiflyContract() || badgesContract() || namesContract())) return
  timer = setInterval(() => { verifyPending().catch(e => console.error('[verify] failed:', errLine(e))) }, Math.max(15_000, intervalMs))
  timer.unref?.()
}
