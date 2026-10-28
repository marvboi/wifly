/**
 * Pending-row verifier ("the indexer"). Tips, badge burns and .wif claims/sales are recorded with a tx hash as
 * pending (verified = 0 / minted = 0). This reads the mined receipt (or ownerOf for names) and only then flips the row:
 *   tips        -> Wifly Tipped(from, creator, postId, amount) with from = one of the tipper's wallets, creator = one of
 *                  the author's wallets, postId = keccak256("post:<dropId>"), amount = the recorded amount. Adds to drops.tip_total.
 *   badge_burns -> WiflyBadges BurnedForBadges(user, amount) with user = one of the burner's wallets.
 *   names       -> WiflyNames.ownerOf (syncName) for unminted claims and pending sales.
 * Read-only: it never sends a transaction and needs no key. A hash that is reused, reverted or doesn't match stays pending.
 */
import { decodeEventLog, keccak256, parseAbi, parseEther, toBytes, type Address, type Hex } from 'viem'
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
  const t = await one<{ id: number; from_id: number; to_id: number; drop_id: string; amount: number; tx_hash: string | null; verified: number }>('SELECT * FROM tips WHERE id = ?', [id])
  if (!t || Number(t.verified) || !t.tx_hash) return false
  const hash = t.tx_hash.toLowerCase()
  if (await one('SELECT 1 FROM tips WHERE tx_hash = ? COLLATE NOCASE AND verified = 1', [hash])) return false // cheap early out; the UPDATE below is the real guard
  const ev = await eventsIn(hash, W, WIFLY_EVENTS); if (!ev) return false
  const [from, to] = await Promise.all([walletsOf(Number(t.from_id)), walletsOf(Number(t.to_id))])
  // the creator's tip destination (chosen + signed, or where their .wif resolves) counts, as does any wallet on their account
  const pay = (await payoutOf(Number(t.to_id))).address; if (pay) to.add(pay)
  const postId = keccak256(toBytes(`post:${t.drop_id}`)).toLowerCase()
  const ok = ev.some(e => e.eventName === 'Tipped' && from.has(String(e.args.from).toLowerCase()) && to.has(String(e.args.creator).toLowerCase())
    && String(e.args.postId).toLowerCase() === postId && e.args.amount === wei(Number(t.amount)))
  if (!ok) return false
  // once-only: flip this row only if no row with the same hash is verified, and count it only if the flip happened.
  // The partial UNIQUE index tips_tx_verified backs this up; a lost race lands in the catch and counts nothing.
  return writeTx(async exec => {
    const u = await exec(`UPDATE tips SET verified = 1 WHERE id = ? AND verified = 0
      AND NOT EXISTS (SELECT 1 FROM tips WHERE tx_hash = ? COLLATE NOCASE AND verified = 1)`, [id, hash])
    if (u.rowsAffected !== 1) return false
    await exec('UPDATE drops SET tip_total = tip_total + ? WHERE id = ?', [Number(t.amount), t.drop_id])
    return true
  }).catch(() => false)
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
