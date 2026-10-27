/**
 * Wifly Plus gate for the AI agent (chat commands, prepared actions, agent execution, "My agent").
 *
 * Live (WIFLY_CONTRACT_ADDRESS + PLUS_CREATOR_ADDRESS set): ONLY the chain decides. Wifly.subStatus(user, PLUS creator)
 * .hasAccess is true while the paid period runs or inside the grace period. A failed read denies (fail closed).
 * Preview (contracts not deployed): the app's Plus mirror (plus_subs, same active/grace rule) so the demo works.
 * The client's idea of Plus is never used.
 */
import { Lru } from './lru'
import { parseAbi, type Address } from 'viem'
import { chainClient } from './chain'
import { plusCreator, wiflyContract } from './config'
import { one } from './db'
import { plusView } from './features'

const SUB_ABI = parseAbi(['function subStatus(address user, address creator) view returns (bool active, bool hasAccess, uint8 tier, uint64 expiry, uint256 graceEndsAt, uint8 plan)'])
export type PlusAccess = { ok: boolean; state: 'active' | 'grace' | 'none' | 'expired' | 'unknown'; source: 'chain' | 'app'; graceEndsAt: number | null; reason?: string }

const TTL = 30_000
const cache = new Lru<number, { at: number; v: PlusAccess }>({ max: 5000, ttlMs: TTL })
export function clearPlusGateCache() { cache.clear() }

async function walletOf(uid: number): Promise<Address | null> {
  const u = await one<{ address: string | null; wallet: string | null }>(`SELECT address,
    (SELECT wallet FROM privy_accounts p WHERE p.user_id = users.id ORDER BY updated_at DESC LIMIT 1) AS wallet FROM users WHERE id = ?`, [uid])
  const a = u?.address ?? u?.wallet
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as Address) : null
}

/** `fresh` skips the 30 s cache (the DCA keeper reads fresh before every scheduled buy). */
export async function plusAccess(uid: number, fresh = false): Promise<PlusAccess> {
  const hit = cache.get(uid)
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.v
  let v: PlusAccess
  const W = wiflyContract(), team = plusCreator()
  if (W && team) {
    const user = await walletOf(uid)
    if (!user) v = { ok: false, state: 'none', source: 'chain', graceEndsAt: null, reason: 'no wallet on your account' }
    else {
      try {
        const [active, hasAccess, , expiry, graceEndsAt] = await chainClient().readContract({ address: W, abi: SUB_ABI, functionName: 'subStatus', args: [user, team] })
        v = { ok: hasAccess, state: active ? 'active' : hasAccess ? 'grace' : Number(expiry) ? 'expired' : 'none', source: 'chain', graceEndsAt: Number(graceEndsAt) ? Number(graceEndsAt) * 1000 : null }
      } catch { v = { ok: false, state: 'unknown', source: 'chain', graceEndsAt: null, reason: 'couldn’t check Plus onchain right now' } }
    }
  } else {
    const p = await plusView(uid)
    v = { ok: p.check, state: p.state === 'active' || p.state === 'grace' || p.state === 'expired' ? p.state : 'none', source: 'app', graceEndsAt: p.graceEndsAt }
  }
  cache.set(uid, { at: Date.now(), v })
  return v
}

/** Plus for a wallet address (the DCA keeper checks the plan OWNER). Live: subStatus(owner) onchain, fail closed.
 *  Preview: the Wifly account that owns the address, through the app mirror. */
export async function plusAccessForAddress(owner: Address): Promise<PlusAccess & { uid: number | null }> {
  const u = await one<{ id: number }>(`SELECT id FROM users WHERE lower(address) = ?1
    UNION SELECT user_id AS id FROM privy_accounts WHERE lower(wallet) = ?1 LIMIT 1`, [owner.toLowerCase()])
  const uid = u ? Number(u.id) : null
  const W = wiflyContract(), team = plusCreator()
  if (W && team) {
    try {
      const [active, hasAccess, , expiry, graceEndsAt] = await chainClient().readContract({ address: W, abi: SUB_ABI, functionName: 'subStatus', args: [owner, team] })
      return { uid, ok: hasAccess, state: active ? 'active' : hasAccess ? 'grace' : Number(expiry) ? 'expired' : 'none', source: 'chain', graceEndsAt: Number(graceEndsAt) ? Number(graceEndsAt) * 1000 : null }
    } catch { return { uid, ok: false, state: 'unknown', source: 'chain', graceEndsAt: null, reason: 'couldn’t check Plus onchain right now' } }
  }
  if (uid === null) return { uid, ok: false, state: 'none', source: 'app', graceEndsAt: null }
  return { uid, ...(await plusAccess(uid, true)) }
}
