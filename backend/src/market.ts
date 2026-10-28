/**
 * The .wif marketplace mirror. Listings live onchain (WiflyNames.listings); name_listings only mirrors them.
 * Every write reads the chain first, and the sweep drops rows whose onchain listing is gone or whose name moved.
 */
import { formatEther, parseAbi, type Address } from 'viem'
import { chainClient } from './chain'
import { namesContract } from './config'
import { all, one, run } from './db'
import { uidForWallet, walletsOfUser } from './accounts'
import { nameTokenId, syncName } from './features'
import { reconcileUser } from './reconcile'

const ABI = parseAbi(['function listings(uint256) view returns (address seller, uint256 price)', 'function ownerOf(uint256) view returns (address)', 'function nameOfToken(uint256) view returns (string)'])
const XFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'])
const lc = (s: unknown) => String(s ?? '').toLowerCase()
const zero = (a: string) => /^0x0{40}$/i.test(a)

/** The onchain listing for a name: null = not listed (or listed by someone who no longer holds it), undefined = chain unreadable. */
export async function chainListing(name: string): Promise<{ seller: string; price: number } | null | undefined> {
  const N = namesContract(); if (!N) return undefined
  try {
    const id = nameTokenId(name)
    const [seller, price] = await chainClient().readContract({ address: N, abi: ABI, functionName: 'listings', args: [id] }) as readonly [Address, bigint]
    if (!seller || zero(seller)) return null
    const owner = await chainClient().readContract({ address: N, abi: ABI, functionName: 'ownerOf', args: [id] }).catch(() => null) as Address | null
    if (!owner || lc(owner) !== lc(seller)) return null
    return { seller: lc(seller), price: Number(formatEther(price)) }
  } catch { return undefined }
}

/** After the user's own list tx: mirror what the chain says (seller must be one of their wallets). */
export async function mirrorListing(name: string, uid: number, buyerId: number | null = null): Promise<{ price: number } | null> {
  const l = await chainListing(name)
  if (!l || !(await walletsOfUser(uid)).has(l.seller)) return null
  await run(`INSERT INTO name_listings (name, seller_id, price, buyer_id, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET price = excluded.price, buyer_id = excluded.buyer_id, seller_id = excluded.seller_id, created_at = excluded.created_at, seed = 0`, [name, uid, l.price, buyerId, Date.now()])
  return { price: l.price }
}

/** Sweep: drop listings that are gone onchain (cancelled, sold, the name moved, e.g. on opensea) and keep prices in step. */
export async function syncListings(limit = 200): Promise<number> {
  if (!namesContract()) return 0
  let changed = 0
  for (const r of await all<{ name: string; seller_id: number; price: number }>('SELECT name, seller_id, price FROM name_listings WHERE seed = 0 ORDER BY created_at ASC LIMIT ?', [limit])) {
    const l = await chainListing(r.name)
    if (l === undefined) continue
    if (!l || !(await walletsOfUser(Number(r.seller_id))).has(l.seller)) { await run('DELETE FROM name_listings WHERE name = ?', [r.name]); changed++; continue }
    if (Math.abs(l.price - Number(r.price)) > 1e-9) { await run('UPDATE name_listings SET price = ? WHERE name = ?', [l.price, r.name]); changed++ }
  }
  return changed
}

/** Sweep: names that moved onchain (opensea, a plain transfer): drop the listing, move the mirror, reconcile both sides. */
export async function backfillTransfers(maxChunks = 8, chunk = 5_000n): Promise<number> {
  const N = namesContract(); if (!N) return 0
  const c = chainClient()
  const head = await c.getBlockNumber()
  const saved = await one<{ v: string }>("SELECT v FROM kv WHERE k = 'names:xfer-cursor'")
  let from = saved ? BigInt(saved.v) : head > 200_000n ? head - 200_000n : 0n
  let n = 0
  for (let i = 0; i < maxChunks && from <= head; i++) {
    const to = from + chunk - 1n < head ? from + chunk - 1n : head
    const logs = await c.getLogs({ address: N, event: XFER[0], fromBlock: from, toBlock: to })
    for (const l of logs) {
      const a = (l as { args?: { from?: string; to?: string; tokenId?: bigint } }).args
      if (!a?.to || a.tokenId === undefined || !a.from || zero(a.from)) continue // mints are NameClaimed's job
      const [fu, tu] = await Promise.all([uidForWallet(a.from), uidForWallet(a.to)])
      if (!fu && !tu) continue
      const name = lc(await c.readContract({ address: N, abi: ABI, functionName: 'nameOfToken', args: [a.tokenId] }).catch(() => '')).replace(/\.wif$/, '')
      if (!name) continue
      await run('DELETE FROM name_listings WHERE name = ?', [name])
      await syncName(name, { onlyKnown: true }).catch(() => null)
      if (fu) await reconcileUser(fu).catch(() => null)
      if (tu) await reconcileUser(tu).catch(() => null)
      n++
    }
    from = to + 1n
    await run("INSERT INTO kv (k, v) VALUES ('names:xfer-cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [String(from)])
  }
  return n
}
