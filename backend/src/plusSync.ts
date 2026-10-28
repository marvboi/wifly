/**
 * Plus mirror from the chain. Wifly.subStatus(wallet, PLUS creator) is the truth; the app's plus_subs row (which drives the
 * check mark, me.plus and the perks) follows it for every wallet on the account: main, linked and the embedded one.
 * Runs right after a payment (and on /api/plus/sync), and lazily from /api/me so a sub paid anywhere shows up on its own.
 * Read-only against the chain. Preview (no contract / no creator): does nothing, the app mirror stays as is.
 */
import { parseAbi, type Address, type Hex } from 'viem'
import { walletsOfUser } from './accounts'
import { chainClient } from './chain'
import { plusCreator, wiflyContract } from './config'
import { one, run } from './db'
import { clearPlusGateCache } from './plusGate'

const SUB_ABI = parseAbi([
  'function subStatus(address user, address creator) view returns (bool active, bool hasAccess, uint8 tier, uint64 expiry, uint256 graceEndsAt, uint8 plan)',
  'function autoRenewOf(address user, address creator) view returns (uint8 tier, uint8 plan, uint240 maxPrice)',
])
/** Which wallet holds the account's sub (the one that has to send setAutoRenew). Filled by every sync. */
const holder = new Map<number, string>()
export function plusWalletOf(uid: number): string | null { return holder.get(uid) ?? null }
const LAZY_MS = 2 * 60_000
const lastLazy = new Map<number, number>()
export function clearPlusSyncThrottle() { lastLazy.clear() }

export type PlusSync = { synced: boolean; expiresAt: number | null; plan: 'month' | 'year' | null; wallet: string | null; changed: boolean; reason?: string }

/** Read subStatus for every wallet on the account and mirror the best one (latest expiry) into plus_subs. */
export async function syncPlusFromChain(uid: number): Promise<PlusSync> {
  const W = wiflyContract(), team = plusCreator()
  if (!W || !team) return { synced: false, expiresAt: null, plan: null, wallet: null, changed: false, reason: 'not live' }
  const wallets = [...(await walletsOfUser(uid))].filter(a => /^0x[0-9a-f]{40}$/.test(a) && a !== team.toLowerCase())
  if (!wallets.length) return { synced: false, expiresAt: null, plan: null, wallet: null, changed: false, reason: 'no wallet' }
  let best: { exp: number; plan: 'month' | 'year'; wallet: string } | null = null
  let failed = 0
  await Promise.all(wallets.map(async w => {
    try {
      const [, , , expiry, , plan] = await chainClient().readContract({ address: W, abi: SUB_ABI, functionName: 'subStatus', args: [w as Address, team] })
      const exp = Number(expiry) * 1000
      if (exp && (!best || exp > best.exp)) best = { exp, plan: Number(plan) === 1 ? 'year' : 'month', wallet: w }
    } catch { failed++ }
  }))
  // a failed read never takes plus away: only a full, clean read may lower the mirror
  if (failed && !best) return { synced: false, expiresAt: null, plan: null, wallet: null, changed: false, reason: 'couldn’t read the chain' }
  const b = best as { exp: number; plan: 'month' | 'year'; wallet: string } | null
  const cur = await one<{ expires_at: number; plan: string }>('SELECT expires_at, plan FROM plus_subs WHERE user_id = ?', [uid])
  const exp = b?.exp ?? 0, plan = b?.plan ?? (cur?.plan === 'year' ? 'year' : 'month')
  if (failed && cur && exp < Number(cur.expires_at)) return { synced: false, expiresAt: Number(cur.expires_at), plan, wallet: b?.wallet ?? null, changed: false, reason: 'partial read' }
  if (b) holder.set(uid, b.wallet); else holder.delete(uid)
  if (holder.size > 20_000) holder.clear()
  // auto-renew lives onchain on the holder wallet; mirror it so the page and the keeper agree with the chain
  let auto: { on: 0 | 1; max: number | null } | null = null
  if (b) {
    try {
      const [, , max] = await chainClient().readContract({ address: W, abi: SUB_ABI, functionName: 'autoRenewOf', args: [b.wallet as Address, team] })
      auto = max > 0n ? { on: 1, max: Number(max / 10n ** 14n) / 1e4 } : { on: 0, max: null }
    } catch { auto = null }
  }
  const curAuto = await one<{ auto_renew: number; agreed_price: number | null }>('SELECT auto_renew, agreed_price FROM plus_subs WHERE user_id = ?', [uid])
  const autoChanged = !!auto && (!curAuto || Number(curAuto.auto_renew) !== auto.on || (auto.on === 1 && Number(curAuto.agreed_price) !== auto.max))
  const changed = (!cur ? exp > 0 : Number(cur.expires_at) !== exp || cur.plan !== plan) || autoChanged
  if (changed) {
    await run(`INSERT INTO plus_subs (user_id, expires_at, plan, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at, plan = excluded.plan, updated_at = excluded.updated_at`, [uid, exp, plan, Date.now()])
    if (auto) await run('UPDATE plus_subs SET auto_renew = ?, agreed_price = COALESCE(?, agreed_price), updated_at = ? WHERE user_id = ?', [auto.on, auto.max, Date.now(), uid])
    clearPlusGateCache()
  }
  return { synced: true, expiresAt: exp || null, plan: b ? plan : null, wallet: b?.wallet ?? null, changed }
}

/** From /api/me: at most once every couple of minutes per account, never throws. */
export async function lazyPlusSync(uid: number) {
  const t = Date.now(), last = lastLazy.get(uid) ?? 0
  if (t - last < LAZY_MS) return
  lastLazy.set(uid, t)
  if (lastLazy.size > 20_000) lastLazy.clear()
  await syncPlusFromChain(uid).catch(() => undefined)
}

/** A Plus payment tx: confirmed, sent to the Wifly contract, from a wallet on this account. */
export async function verifyPlusTx(uid: number, hash: Hex): Promise<boolean> {
  const W = wiflyContract()
  if (!W) return false
  try {
    const r = await chainClient().getTransactionReceipt({ hash })
    if (r.status !== 'success' || r.to?.toLowerCase() !== W.toLowerCase()) return false
    return (await walletsOfUser(uid)).has(r.from.toLowerCase())
  } catch { return false }
}
