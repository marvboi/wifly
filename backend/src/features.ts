/**
 * Onboarding, usernames market (WiflyNames), creator tiers, Wifly Plus renewal, and burn-for-badges (WiflyBadges).
 *
 * Money never moves here. Every purchase, renewal and burn is an onchain transaction the user signs; the API only
 * records a tx hash as pending (verified = 0) and the chain stays the source of truth. Nothing here invents a hash.
 */
import { clientIp } from './abuse'
import { cached, rpcCached } from './cache'
import type { Hono } from 'hono'
import { decodeEventLog, keccak256, parseAbi, toBytes, type Address } from 'viem'
import { needUser, type Env } from './auth'
import { chainClient } from './chain'
import { BADGE_TIERS, FEE_SPLIT, splitFee, LIMITS, NAME_FEE_BPS, nameClaimFee, PLUS_GRACE_MS, badgesContract, demoSeedAllowed, namesContract, namesRendererContract, plusPlans, wiflyContract, type PlusPlan } from './config'
import { all, one, run } from './db'
import { hydrateUsers, type UserRow } from './hydrate'
import { clearRankCache } from './rank'
import { needsHandle } from './pending'
import { adoptName, bumpOf, dropName, renameFree, settleBumps, wifClaimed } from './identity'
import { charCount, fail, rateLimit } from './util'
import { audit, isAdmin, listAccounts, softDeleteUser, uidForWallet, walletsOfUser } from './accounts'
import { MAX_THEME, renderNameSvg, unclaimedPreview } from './names-art'
import { setReconcileNotify } from './reconcile'
import { lazyPlusSync, plusWalletOf, syncPlusFromChain, verifyPlusTx } from './plusSync'
import { chainListing, mirrorListing } from './market'

const now = () => Date.now()
/** Same rule as WiflyNames.isValidName: 3-20 bytes of [a-z0-9_]. Input is lowercased first. */
export const HANDLE_RE = new RegExp(`^[a-z0-9_]{${LIMITS.handleMin},${LIMITS.handleMax}}$`)
/** Route words, brand words and impersonation bait. */
export const RESERVED = new Set([
  'ass', // retired for good: never a handle or a .wif name
  'home', 'search', 'notifications', 'settings', 'admin', 'administrator', 'api', 'you', 'me', 'wifly', 'wif', 'worldisflat',
  'support', 'help', 'plus', 'agent', 'names', 'market', 'welcome', 'login', 'signin', 'signup', 'logout', 'messages',
  'bookmarks', 'vote', 'pay', 'post', 'root', 'system', 'official', 'team', 'staff', 'mod', 'moderator', 'security',
  'marv', 'about', 'terms', 'privacy', 'badges', 'burn', 'null', 'undefined', 'robinhood', 'robinhoodchain', 'pons', 'uniswap', 'healthz',
  'u', 'n', 'swap', 'dca', 'deploy', 'docs', 'pot', 'followers', 'following', 'onboarding', 'guest', 'link', 'share', 'feed', 'explore', 'trending', 'drops', 'drop', 'status', 'assets', 'brand', 'static', 'favicon', 'manifest', 'app', 'www', 'landing', 'tip', 'tips', 'wallet', 'auth', 'oauth', 'callback', 'uploads', 'fonts',
])
const TX_RE = /^0x[0-9a-f]{64}$/i
const isTx = (s: unknown): s is string => typeof s === 'string' && TX_RE.test(s)
const money = (v: unknown, max = 1e9) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > max) fail(400, 'enter a price in wif'); return Math.round(n * 100) / 100 }
const parse = (s: string | null | undefined) => { try { return JSON.parse(s || '{}') } catch { return {} } }

/** WiflyNames token id for a name: uint256(keccak256(lowercase name)). */
export const nameTokenId = (name: string) => BigInt(keccak256(toBytes(name.toLowerCase())))

export type HandleCheck = { handle: string; available: boolean; reason?: 'invalid' | 'reserved' | 'taken' | 'x-reserved' | 'wif-owned' | 'listed' | 'yours'; message?: string; price?: number; claimFee: number; suggestions: string[]; wifFree?: boolean }

/** Is `raw` free for user `uid`? Same rules for onboarding, edit profile and the names market. */
export async function checkHandle(raw: string, uid: number | null): Promise<HandleCheck> {
  const h = String(raw ?? '').trim().replace(/^@/, '').toLowerCase()
  const out = async (r: Omit<HandleCheck, 'handle' | 'suggestions' | 'claimFee'>, sugg = false): Promise<HandleCheck> =>
    ({ handle: h, claimFee: nameClaimFee(h), ...r, suggestions: sugg ? await suggestHandles(h) : [] })
  if (!HANDLE_RE.test(h)) return out({ available: false, reason: 'invalid', message: `${LIMITS.handleMin}–${LIMITS.handleMax} lowercase letters, numbers or _` })
  const lower = h.toLowerCase()
  if (RESERVED.has(lower)) return out({ available: false, reason: 'reserved', message: 'that one is reserved' }) // no twists on a reserved word
  const user = await one<{ id: number }>('SELECT id FROM users WHERE handle = ? COLLATE NOCASE', [h])
  if (user && Number(user.id) === uid) return out({ available: true, reason: 'yours', message: 'that’s you' })
  if (user) return out({ available: false, reason: 'taken', message: 'taken' }, true)
  // People who signed in with X keep their X handle: nobody else can take it.
  const x = await one<{ user_id: number }>('SELECT user_id FROM privy_accounts WHERE lower(x_username) = ? LIMIT 1', [lower])
  if (x && Number(x.user_id) !== uid) return out({ available: false, reason: 'x-reserved', message: 'linked to the X account with that handle' }, true)
  // Owning x.wif wins @x, so a free @x can't be picked once x.wif is claimed by someone else (mirror or chain).
  // the chain decides who owns x.wif. If it's one of your wallets, @x is yours (and the mirror catches up).
  const w = await one<{ owner_id: number; minted: number }>('SELECT owner_id, minted FROM names WHERE name = ?', [lower])
  if (w && Number(w.owner_id) === uid && (Number(w.minted) || !namesContract())) return out({ available: true, reason: 'yours', message: `you own ${lower}.wif` })
  if (namesContract()) {
    const owner = await chainOwnerOf(lower)
    if (owner !== undefined) {
      if (!owner) return out({ available: !w, ...(w ? { reason: 'wif-owned' as const, message: `${lower}.wif is owned by another wallet` } : { wifFree: true }) }, !!w)
      const ownerUid = await uidForWallet(owner)
      if (uid && ownerUid === uid) { await syncName(lower).catch(() => null); return out({ available: true, reason: 'yours', message: `you own ${lower}.wif` }) }
      return out({ available: false, reason: 'wif-owned', message: `${lower}.wif is owned by another wallet` }, true)
    }
  }
  if (w) return out({ available: false, reason: 'wif-owned', message: `${lower}.wif is owned by another wallet` }, true)
  return out({ available: true, wifFree: !namesContract() })
}

/** The .wif this account's wallets hold that would be "yours" as an @name: each wallet's onchain primary (reverseName), then a minted mirror row. */
async function ownedWifFor(uid: number, skip?: string | null): Promise<string | null> {
  const N = namesContract()
  const tries: string[] = []
  if (N) for (const w of await walletsOfUser(uid)) {
    const nm = await rpcCached(`ns:rev:${w}`, 10_000, () => chainClient().readContract({ address: N, abi: NS_ABI, functionName: 'reverseName', args: [w as Address] })).catch(() => '')
    const label = String(nm || '').toLowerCase().replace(/\.wif$/, '')
    if (label) tries.push(label)
  }
  for (const r of await all<{ name: string }>('SELECT name FROM names WHERE owner_id = ? AND (minted = 1 OR ?) ORDER BY created_at ASC LIMIT 4', [uid, N ? 0 : 1]).catch(() => [])) tries.push(r.name)
  for (const t of [...new Set(tries)]) if (t !== skip && HANDLE_RE.test(t) && !RESERVED.has(t) && (await checkHandle(t, uid)).reason === 'yours') return t
  return null
}

async function freeQuick(h: string) {
  if (!HANDLE_RE.test(h) || RESERVED.has(h.toLowerCase())) return false
  return !(await one(`SELECT 1 FROM users WHERE handle = ? COLLATE NOCASE
    UNION SELECT 1 FROM privy_accounts WHERE lower(x_username) = lower(?) UNION SELECT 1 FROM names WHERE name = ?`, [h, h, h.toLowerCase()]))
}
async function suggestHandles(base: string): Promise<string[]> {
  const b = base.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, LIMITS.handleMax - 4) || 'flat'
  const out: string[] = []
  for (const t of variants(b)) { if (out.length >= 3) break; if (await freeQuick(t) && await chainFree(t)) out.push(t) }
  return out
}

export async function setHandle(uid: number, h: string) {
  const c = await checkHandle(h, uid)
  if (!c.available) fail(c.reason === 'invalid' ? 400 : 409, c.reason === 'reserved' ? 'that handle is reserved' : c.reason === 'x-reserved' ? 'that handle is linked to an X account'
    : c.reason === 'invalid' ? `handles are ${LIMITS.handleMin}–${LIMITS.handleMax} letters, numbers or _` : 'that handle is taken')
  const cur = await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [uid])
  if (c.reason === 'yours' && cur?.handle.toLowerCase() === c.handle) return
  const wif = await primaryOf(uid)
  if (c.reason === 'yours' && (await one('SELECT 1 FROM names WHERE name = ? AND owner_id = ?', [c.handle, uid]))) {
    // you own x.wif: picking @x makes it your main name (one step, no "taken" for your own name)
    if (wif !== c.handle) { await adoptName(uid, c.handle, notifyRef); return }
  }
  if (wif) fail(409, `your @ follows your .wif (${wif}.wif). switch your main .wif to change it`)
  await renameFree(uid, c.handle)
}

// ------------------------------------------------------------------ .wif names

export type NameCheck = { name: string; display: string; available: boolean; reason?: 'invalid' | 'reserved' | 'taken' | 'listed' | 'yours'; message?: string; price?: number; owner?: { handle: string; wifName?: string | null } | null; claimFee: number; suggestions: string[]; live: boolean }

/** Is `raw.wif` free to claim on WiflyNames? Mirrors isAvailable; when the contract is live the chain answers. */
export async function checkName(raw: string, uid: number | null): Promise<NameCheck> {
  const n = String(raw ?? '').trim().replace(/^@/, '').replace(/\.wif$/i, '').toLowerCase()
  const live = !!namesContract()
  const out = async (r: Omit<NameCheck, 'name' | 'display' | 'suggestions' | 'claimFee' | 'live'>, sugg = false): Promise<NameCheck> =>
    ({ name: n, display: `${n}.wif`, claimFee: nameClaimFee(n), live, ...r, suggestions: sugg ? await suggestNames(n) : [] })
  if (!HANDLE_RE.test(n)) return out({ available: false, reason: 'invalid', message: `${LIMITS.handleMin}–${LIMITS.handleMax} lowercase letters, numbers or _` })
  if (RESERVED.has(n)) return out({ available: false, reason: 'reserved', message: 'reserved' }) // no twists on a reserved word
  let row = await one<{ owner_id: number; minted: number }>('SELECT owner_id, minted FROM names WHERE name = ?', [n])
  if (row && Number(row.owner_id) === uid && (Number(row.minted) || !live)) return out({ available: false, reason: 'yours', message: `you own ${n}.wif` })
  if (live) {
    // when the chain says it's claimed, ask who holds it. Your own wallet = yours (and the mirror is backfilled,
    // which is how a claim the app missed gets recorded). Before, a missing mirror row always read "taken by another wallet".
    const owner = await chainOwnerOf(n)
    if (owner === null) return out({ available: true })
    if (owner) {
      const ownerUid = await uidForWallet(owner)
      if (uid && ownerUid === uid) { await syncName(n).catch(() => null); return out({ available: false, reason: 'yours', message: `you own ${n}.wif` }) }
      if (ownerUid && (!row || Number(row.owner_id) !== ownerUid)) { await syncName(n, { onlyKnown: true }).catch(() => null); row = { owner_id: ownerUid, minted: 1 } }
      else if (!ownerUid && row && !Number(row.minted)) row = undefined // an unconfirmed claim never outranks the chain
      if (!row) return out({ available: false, reason: 'taken', message: 'held by another wallet', owner: null }, true)
    }
  }
  if (row) {
    const owner = (await hydrateUsers([Number(row.owner_id)], uid)).get(Number(row.owner_id))
    const l = await one<{ price: number }>('SELECT price FROM name_listings WHERE name = ?', [n])
    if (l) return out({ available: false, reason: 'listed', message: 'taken, but it’s for sale', price: Number(l.price), owner: owner ? { handle: owner.handle, wifName: owner.wifName } : null }, true)
    return out({ available: false, reason: 'taken', message: 'taken by another wallet', owner: owner ? { handle: owner.handle, wifName: owner.wifName } : null }, true)
  }
  return out({ available: true })
}
const CLAIMED_EV = parseAbi(['event NameClaimed(uint256 indexed tokenId, string name, address indexed owner, uint256 fee)'])
/** Does this mined tx carry WiflyNames.NameClaimed for `n`? */
async function claimedIn(hash: string, n: string): Promise<boolean> {
  const rc = await chainClient().getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null)
  if (!rc || rc.status !== 'success') return false
  return rc.logs.some(l => { if (l.address.toLowerCase() !== String(namesContract()).toLowerCase()) return false
    try { const e = decodeEventLog({ abi: CLAIMED_EV, data: l.data, topics: l.topics }); return String(e.args.name).toLowerCase().replace(/\.wif$/, '') === n } catch { return false } })
}
/** Calm look-alikes: no "_wif" tails or random digits first. */
function variants(b: string): string[] {
  if (hasReservedWord(b)) return [] // never suggest twists on a reserved word (live used to offer ass_wif, theass, assflat)
  return [`the${b}`, `${b}hq`, `its${b}`, `real${b}`, `${b}flat`, `hey${b}`, `${b}_xyz`].map(t => t.slice(0, LIMITS.handleMax)).filter(t => !hasReservedWord(t))
}
const AFFIXES = ['the', 'hq', 'its', 'real', 'flat', 'hey', 'wif', 'xyz', 'official', 'og']
/** Words that can't appear anywhere inside a suggestion. 'ass' always; plus every reserved word of 5+ letters (wifly, admin, robinhood…). */
const BLOCK_INSIDE = ['ass', ...[...RESERVED].filter(w => w.length >= 5)]
/** True when a suggestion is a reserved word in disguise: contains a blocked word, has a reserved part between _, or is a reserved word plus our affixes. */
export function hasReservedWord(t: string): boolean {
  const s = t.toLowerCase()
  if (RESERVED.has(s) || BLOCK_INSIDE.some(w => s.includes(w))) return true
  if (s.split('_').some(p => p && RESERVED.has(p))) return true
  let core = s.replace(/_/g, '')
  for (let i = 0; i < 3; i++) for (const a of AFFIXES) { if (core.startsWith(a) && core.length > a.length) core = core.slice(a.length); if (core.endsWith(a) && core.length > a.length) core = core.slice(0, -a.length) }
  return RESERVED.has(core)
}
/** Owner of x.wif onchain: lowercase address, null when unclaimed, undefined when the chain can't be read. */
export async function chainOwnerOf(n: string): Promise<string | null | undefined> {
  const addr = namesContract(); if (!addr) return undefined
  try {
    const o = await rpcCached(`ns:owner:${n}`, 10_000, () => chainClient().readContract({ address: addr as Address, abi: NS_ABI, functionName: 'ownerOfName', args: [n] }))
    return !o || /^0x0{40}$/i.test(o) ? null : o.toLowerCase()
  } catch { return undefined }
}
const chainFree = async (n: string) => (await chainOwnerOf(n)) !== undefined ? (await chainOwnerOf(n)) === null : true
async function suggestNames(base: string): Promise<string[]> {
  const b = base.replace(/[^a-z0-9_]/g, '').slice(0, LIMITS.handleMax - 4) || 'flat'
  const out: string[] = []
  for (const t of variants(b)) { if (out.length >= 3) break; if (HANDLE_RE.test(t) && !RESERVED.has(t) && !(await one('SELECT 1 FROM names WHERE name = ?', [t])) && await chainFree(t)) out.push(t) }
  return out
}

/** WIF Names (WIFNAME) reads, final API (contracts/docs/WIF-NAMES.md). Every call accepts "alice" or "alice.wif" and never reverts. */
const NS_ABI = [
  { type: 'function', name: 'isAvailable', stateMutability: 'view', inputs: [{ name: 'name', type: 'string' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'resolve', stateMutability: 'view', inputs: [{ name: 'name', type: 'string' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'ownerOfName', stateMutability: 'view', inputs: [{ name: 'name', type: 'string' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'reverseName', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'text', stateMutability: 'view', inputs: [{ name: 'name', type: 'string' }, { name: 'key', type: 'string' }], outputs: [{ type: 'string' }] },
] as const
/** Text-record values are at most 256 bytes onchain (MAX_TEXT_LEN). */
export const MAX_TEXT_BYTES = 256
const bytesOf = (s: string) => Buffer.byteLength(s, 'utf8')
export const RECORD_KEYS = ['avatar', 'x', 'url', 'bio'] as const
type RecordRow = { name: string; address: string | null; avatar: string | null; x: string | null; url: string | null; bio: string | null; updated_at: number }

/** Where name.wif points: resolve(name) onchain when live, else the owner's wallet from the mirror. Never the @handle. */
export async function resolveName(name: string) {
  const n = name.toLowerCase().replace(/\.wif$/, '')
  const addr = namesContract()
  if (addr) {
    try {
      // resolve() returns the setAddr record, else the owner; 0x0 when unclaimed.
      const a = await rpcCached(`ns:resolve:${n}`, 30_000, () => chainClient().readContract({ address: addr, abi: NS_ABI, functionName: 'resolve', args: [`${n}.wif`] }))
      if (a && !/^0x0{40}$/i.test(a)) return { address: a.toLowerCase(), source: 'chain' as const }
    } catch { /* rpc down */ }
    return null
  }
  const r = await one<{ address: string | null; owner_address: string | null; wallet: string | null }>(`SELECT r.address, u.address AS owner_address,
    (SELECT wallet FROM privy_accounts p WHERE p.user_id = u.id ORDER BY updated_at DESC LIMIT 1) AS wallet
    FROM names n JOIN users u ON u.id = n.owner_id LEFT JOIN name_records r ON r.name = n.name WHERE n.name = ?`, [n])
  if (!r) return null
  const a = r.address ?? r.owner_address ?? r.wallet
  return a ? { address: a.toLowerCase(), source: 'mirror' as const } : { address: null, source: 'mirror' as const }
}

/** A name changed hands: records reset and it stops being the old owner's primary. */
export async function resetNameOnTransfer(name: string, fromUid: number | null) {
  await run('DELETE FROM name_records WHERE name = ?', [name])
  if (fromUid) {
    await run(`UPDATE users SET extras = json_remove(extras, '$.wifName') WHERE id = ? AND lower(json_extract(extras, '$.wifName')) = lower(?)`, [fromUid, name])
    await dropName(fromUid, name)
  }
}

// ------------------------------------------------------------------ Plus

export type PlusState = 'none' | 'active' | 'grace' | 'expired'
type PlusRow = { user_id: number; expires_at: number; plan: PlusPlan; auto_renew: number; agreed_price: number | null; last_renewed_period: number | null }

/**
 * Plus status from the tracked expiry:
 *  active  → now < expiry
 *  grace   → expiry ≤ now < expiry + 5 days (check still shown; renew to keep it)
 *  expired → after the grace period (the check is gone)
 * Auto-renew: opt-in; only after expiry or during the grace period; only while it is on; takes exactly the
 * agreed price; once per period; if the plan price goes above the agreed price it stops and asks to confirm the new price;
 * pulls from the in-app deposit first, then the WIF approval; turning it off stops it at once.
 */
export async function plusView(uid: number, at = now()) {
  const plans = plusPlans()
  const r = await one<PlusRow>('SELECT * FROM plus_subs WHERE user_id = ?', [uid])
  const exp = r ? Number(r.expires_at) : 0
  let state: PlusState = 'none'
  if (exp) state = at < exp ? 'active' : at < exp + PLUS_GRACE_MS ? 'grace' : 'expired'
  const plan: PlusPlan = r?.plan === 'year' ? 'year' : 'month'
  const price = plans[plan].price
  const auto = !!Number(r?.auto_renew)
  const agreed = r?.agreed_price != null ? Number(r.agreed_price) : null
  const priceChanged = auto && agreed !== null && price > agreed
  const renewedThisPeriod = !!r && r.last_renewed_period !== null && Number(r.last_renewed_period) === exp
  return {
    state, plan, price, plans: Object.values(plans), check: state === 'active' || state === 'grace',
    expiresAt: exp || null, graceEndsAt: exp ? exp + PLUS_GRACE_MS : null, graceDays: PLUS_GRACE_MS / 86400_000,
    autoRenew: auto, agreedPrice: agreed, priceChanged,
    renewsOn: auto && !priceChanged && exp && state !== 'expired' ? exp : null,
    renewableNow: auto && !priceChanged && !renewedThisPeriod && state === 'grace',
  }
}

/** Who the keeper may renew right now: expired but inside grace, auto-renew on, price not above the agreed one, not yet renewed this period. */
export async function duePlusRenewals(at = now()) {
  const plans = plusPlans()
  const rows = await all<PlusRow>('SELECT * FROM plus_subs WHERE auto_renew = 1 AND expires_at > 0 AND expires_at <= ? AND expires_at + ? > ?', [at, PLUS_GRACE_MS, at])
  return rows.filter(r => r.agreed_price != null && plans[r.plan === 'year' ? 'year' : 'month'].price <= Number(r.agreed_price)
    && (r.last_renewed_period === null || Number(r.last_renewed_period) !== Number(r.expires_at)))
    .map(r => ({ userId: Number(r.user_id), plan: r.plan, price: plans[r.plan === 'year' ? 'year' : 'month'].price, period: Number(r.expires_at) }))
}

/** Apply a verified Plus payment (the indexer calls this once the Wifly event is confirmed). */
export async function applyPlusPayment(uid: number, plan: PlusPlan, renewal: boolean, at = now()) {
  const days = plusPlans()[plan].days
  const r = await one<PlusRow>('SELECT * FROM plus_subs WHERE user_id = ?', [uid])
  const exp = r ? Number(r.expires_at) : 0
  // Still active or inside grace: extend from the old expiry (the calendar holds). After grace: a fresh period from now.
  const from = exp && at < exp + PLUS_GRACE_MS ? exp : at
  const next = from + days * 86400_000
  await run(`INSERT INTO plus_subs (user_id, expires_at, plan, updated_at, last_renewed_period) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at, plan = excluded.plan, updated_at = excluded.updated_at,
    last_renewed_period = excluded.last_renewed_period`, [uid, next, plan, at, renewal ? exp : null])
  return next
}

// ------------------------------------------------------------------ badges

export async function badgeView(uid: number) {
  const r = await one<{ s: number }>('SELECT COALESCE(SUM(amount), 0) AS s FROM badge_burns WHERE user_id = ? AND verified = 1', [uid])
  const p = await one<{ s: number }>('SELECT COALESCE(SUM(amount), 0) AS s FROM badge_burns WHERE user_id = ? AND verified = 0', [uid])
  const burned = Number(r?.s ?? 0)
  const tiers = BADGE_TIERS.map(t => ({ ...t, earned: burned >= t.min }))
  const next = tiers.find(t => !t.earned) ?? null
  return { burned, pending: Number(p?.s ?? 0), tiers, top: [...tiers].reverse().find(t => t.earned)?.id ?? null, next: next ? { ...next, left: next.min - burned } : null }
}

async function primaryOf(uid: number): Promise<string | null> {
  const r = await one<{ n: string | null }>(`SELECT lower(json_extract(u.extras, '$.wifName')) AS n FROM users u JOIN names m ON m.name = json_extract(u.extras, '$.wifName') AND m.owner_id = u.id WHERE u.id = ?`, [uid])
  return r?.n ?? null
}
async function setPrimaryName(uid: number, name: string) {
  await run(`UPDATE users SET extras = json_set(COALESCE(extras, '{}'), '$.wifName', ?) WHERE id = ?`, [name.toLowerCase(), uid])
}
async function recordsOf(name: string) {
  const r = await one<RecordRow>('SELECT * FROM name_records WHERE name = ?', [name])
  return { address: r?.address ?? null, avatar: r?.avatar ?? null, x: r?.x ?? null, url: r?.url ?? null, bio: r?.bio ?? null, updatedAt: r ? Number(r.updated_at) : null }
}

// ------------------------------------------------------------------ routes

type Helpers = { me: (uid: number) => Promise<unknown>; notify: (to: number, actor: number, kind: string, dropId: string | null, meta?: object) => Promise<void> }
type ListingRow = { name: string; seller_id: number; price: number; buyer_id: number | null; seed: number; created_at: number }

/** Mirror one name's owner from WiflyNames.ownerOf (null = not minted). Used by /sync and the pending sweep in verify.ts. */
export async function syncName(name: string, opts: { onlyKnown?: boolean } = {}): Promise<{ owner: Address; known: boolean } | null> {
  const addr = namesContract()
  if (!addr) return null
  name = name.toLowerCase()
  let owner: Address
  try {
    owner = await chainClient().readContract({ address: addr, abi: [{ type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] }] as const, functionName: 'ownerOf', args: [nameTokenId(name)] })
  } catch { return null }
  const oid = await uidForWallet(owner)
  const u = oid ? { id: oid } : null
  // the automatic sweep never resets a mirror row to an address it can't place (e.g. a wallet not linked yet)
  if (!u && opts.onlyKnown) return { owner, known: false }
  const prev = await one<{ owner_id: number }>('SELECT owner_id FROM names WHERE name = ?', [name])
  if (prev && (!u || Number(prev.owner_id) !== Number(u.id))) await resetNameOnTransfer(name, Number(prev.owner_id))
  if (!u) { await wifClaimed(name, null, notifyRef); return { owner, known: false } }
  await run('INSERT INTO names (name, owner_id, minted, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(name) DO UPDATE SET owner_id = excluded.owner_id, minted = 1', [name, u.id, now()])
  try { // card theme lives onchain and survives the sale
    const t = await chainClient().readContract({ address: addr, abi: [{ type: 'function', name: 'theme', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'uint8' }] }] as const, functionName: 'theme', args: [nameTokenId(name)] })
    await run('UPDATE names SET theme = ? WHERE name = ?', [Number(t), name])
  } catch { /* keep the mirror */ }
  await run('DELETE FROM name_listings WHERE name = ? AND seller_id <> ?', [name, u.id])
  await run('UPDATE name_sales SET verified = 1 WHERE name = ? AND buyer_id = ?', [name, u.id])
  await wifClaimed(name, Number(u.id), notifyRef)
  return { owner, known: true }
}
let notifyRef: Helpers['notify'] | undefined

export function registerFeatures(app: Hono<Env>, h: Helpers) {
  notifyRef = h.notify
  setReconcileNotify(h.notify)
  // ---- onboarding
  app.get('/api/handles/check', async c => {
    await rateLimit(`hc:${c.get('uid') ?? clientIp(c)}`, 120, 60_000)
    return c.json(await checkHandle(c.req.query('h') ?? '', c.get('uid')))
  })

  app.get('/api/onboarding', async c => {
    const uid = needUser(c)
    const p = await one<{ x_username: string | null; email: string | null; wallet: string | null }>('SELECT x_username, email, wallet FROM privy_accounts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [uid])
    const u = await one<UserRow>('SELECT * FROM users WHERE id = ?', [uid])
    const x = p?.x_username ?? null
    // a .wif one of your wallets already holds is offered first, one tap; notice = the @name that went to its .wif holder
    const ownedWif = needsHandle(u) ? await ownedWifFor(uid) : null
    const suggested = ownedWif ?? (x && (await checkHandle(x, uid)).available ? x.toLowerCase() : null)
    const people = await all<{ id: number }>(`SELECT id FROM users WHERE id <> ? AND onboarded = 1 AND id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ?)
      ORDER BY creator DESC, (SELECT COUNT(*) FROM follows WHERE followee_id = users.id) + COALESCE(json_extract(extras, '$.baseFollowers'), 0) DESC LIMIT 8`, [uid, uid])
    const map = await hydrateUsers(people.map(r => Number(r.id)), uid)
    const tags = await all<{ tag: string }>(`SELECT tag, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC LIMIT 12`)
    return c.json({
      suggestedHandle: suggested, ownedWif, notice: needsHandle(u) ? (JSON.parse(u?.extras || '{}').handleNotice ?? null) : null, x: x ? { username: x } : null, wallet: p?.wallet ?? u?.address ?? null, email: !!p?.email,
      users: people.map(r => map.get(Number(r.id))).filter(Boolean), tags: tags.map(t => t.tag),
    })
  })

  app.post('/api/onboarding', async c => {
    const uid = needUser(c)
    const b = await c.req.json<{ handle?: string; name?: string; bio?: string; avatar?: string | null; follow?: string[]; tags?: string[] }>().catch(() => ({} as Record<string, never>))
    const cur = await one<{ handle: string; extras: string | null }>('SELECT handle, extras FROM users WHERE id = ?', [uid])
    if (b.handle === undefined && needsHandle(cur)) fail(400, 'pick your @name first')
    if (b.handle !== undefined) {
      // claimed a .wif as main name during onboarding: the @ already follows it, so finishing never fights it (was a 409)
      const wifNow = await primaryOf(uid)
      if (!(wifNow && cur?.handle.toLowerCase() === wifNow)) await setHandle(uid, String(b.handle)) // free @name; a .wif is an optional upgrade
    }
    const sets: string[] = [], args: (string | null)[] = []
    if (b.name !== undefined) { const n = String(b.name).trim(); if (!n || charCount(n) > LIMITS.nameChars) fail(400, `names are 1–${LIMITS.nameChars} characters`); sets.push('name = ?'); args.push(n) }
    if (b.bio !== undefined) { const s = String(b.bio).trim(); if (charCount(s) > LIMITS.bioChars) fail(400, `bios are up to ${LIMITS.bioChars} characters`); sets.push('bio = ?'); args.push(s) }
    if (b.avatar !== undefined) {
      if (b.avatar !== null && !/^\/uploads\/[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/.test(String(b.avatar))) fail(400, 'avatar must be an uploaded image')
      sets.push('avatar = ?'); args.push(b.avatar)
    }
    const tags = (Array.isArray(b.tags) ? b.tags : []).map(t => String(t).toLowerCase().replace(/[^a-z0-9_]/g, '')).filter(Boolean).slice(0, 12)
    // one extras assignment (sqlite keeps only the last one per column)
    if (tags.length || b.handle !== undefined) {
      let ex = `COALESCE(extras, '{}')`
      if (b.handle !== undefined) ex = `json_remove(json_set(${ex}, '$.handlePicked', 1), '$.handleNotice')`
      if (tags.length) { ex = `json_set(${ex}, '$.interests', json(?))`; args.push(JSON.stringify(tags)) }
      sets.push(`extras = ${ex}`)
    }
    await run(`UPDATE users SET ${[...sets, 'onboarded = 1'].join(', ')} WHERE id = ?`, [...args, uid])
    for (const fh of (Array.isArray(b.follow) ? b.follow : []).slice(0, 30)) {
      const t = await one<{ id: number }>('SELECT id FROM users WHERE handle = ? COLLATE NOCASE', [String(fh)])
      if (!t || Number(t.id) === uid) continue
      const r = await run('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)', [uid, t.id, now()])
      if (r.rowsAffected) await h.notify(Number(t.id), uid, 'follow', null)
    }
    clearRankCache()
    return c.json({ me: await h.me(uid) })
  })

  /** Your @name, your main .wif, a bump notice if someone claimed your name's .wif, and whether that .wif is still free (the nudge). */
  app.get('/api/me/identity', async c => {
    const uid = needUser(c)
    await settleBumps()
    const u = await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [uid])
    const wif = await primaryOf(uid)
    const bump = await bumpOf(uid)
    const nm = u!.handle.toLowerCase()
    const chk = wif || bump || /^wif_u\d+$/.test(nm) ? null : await checkName(nm, uid)
    return c.json({
      handle: u!.handle, wifName: wif, bump,
      nudge: chk && chk.available ? { name: nm, display: `${nm}.wif`, claimFee: chk.claimFee, live: chk.live } : null,
    })
  })
  const sweep = setInterval(() => { settleBumps().catch(() => {}) }, 10 * 60_000); sweep.unref?.()

  // ---- names market (WiflyNames)
  const listingJson = async (rows: ListingRow[], uid: number | null) => {
    const users = await hydrateUsers(rows.map(r => Number(r.seller_id)), uid)
    const offers = new Map((await all<{ name: string; n: number; top: number }>(`SELECT name, COUNT(*) AS n, MAX(price) AS top FROM name_offers WHERE status = 'open' AND expires_at > ? GROUP BY name`, [now()])).map(o => [o.name.toLowerCase(), o]))
    return rows.map(r => {
      const fee = Number(r.price) * NAME_FEE_BPS / 10_000
      const o = offers.get(r.name.toLowerCase())
      return {
        name: r.name, price: Number(r.price), seller: users.get(Number(r.seller_id)), private: false, mine: Number(r.seller_id) === uid,
        forYou: r.buyer_id !== null && Number(r.buyer_id) === uid, listedAt: Number(r.created_at),
        fee: { total: fee, ...splitFee(fee), sellerGets: Number(r.price) - fee }, offers: Number(o?.n ?? 0), topOffer: o ? Number(o.top) : null,
        tokenId: nameTokenId(r.name).toString(),
      }
    })
  }
  app.get('/api/names/market', async c => {
    const uid = c.get('uid')
    const sort = c.req.query('sort') ?? 'new'
    const q = (c.req.query('q') ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '')
    return c.json(await cached(['names'], `nm:${uid ?? 0}:${sort}:${q}`, 15_000, async () => {
    const order = sort === 'low' ? 'price ASC' : sort === 'high' ? 'price DESC' : sort === 'short' ? 'length(name) ASC, price ASC' : 'created_at DESC'
    const rows = await all<ListingRow>(`SELECT * FROM name_listings ${q ? 'WHERE name LIKE ?' : ''} ORDER BY ${order} LIMIT 60`, q ? [`%${q}%`] : [])
    const sales = await all<{ name: string; price: number; created_at: number }>('SELECT name, price, created_at FROM name_sales WHERE verified = 1 ORDER BY created_at DESC LIMIT 10')
    return { listings: await listingJson(rows, uid), recentSales: sales, live: !!namesContract(), feeBps: NAME_FEE_BPS, feeSplit: FEE_SPLIT }
    }))
  })
  app.get('/api/names/mine', async c => {
    const uid = needUser(c)
    const primary = await primaryOf(uid)
    const names = await all<{ name: string; minted: number; theme: number }>('SELECT name, minted, theme FROM names WHERE owner_id = ? ORDER BY created_at', [uid])
    const listed = new Map((await all<ListingRow>('SELECT * FROM name_listings WHERE seller_id = ?', [uid])).map(l => [l.name.toLowerCase(), l]))
    const offersIn = await all<{ id: number; name: string; buyer: string; price: number; expires_at: number }>(`SELECT o.id, o.name, u.handle AS buyer, o.price, o.expires_at FROM name_offers o
      JOIN users u ON u.id = o.buyer_id JOIN names n ON n.name = o.name WHERE n.owner_id = ? AND o.status = 'open' AND o.expires_at > ? ORDER BY o.price DESC`, [uid, now()])
    const offersOut = await all<{ id: number; name: string; price: number; expires_at: number }>(`SELECT id, name, price, expires_at FROM name_offers WHERE buyer_id = ? AND status = 'open' AND expires_at > ? ORDER BY created_at DESC`, [uid, now()])
    // a .wif this account holds (wifly records or a linked wallet onchain) that isn't its name here yet: settings offers "use it" only then
    const current = String(JSON.parse((await one<{ extras: string | null }>('SELECT extras FROM users WHERE id = ?', [uid]))?.extras || '{}').wifName ?? '').toLowerCase() || null
    const usable = await ownedWifFor(uid, current).catch(() => null)
    return c.json({
      primary, current, usable,
      names: names.map(n => { const l = listed.get(n.name.toLowerCase()); return { name: n.name, display: `${n.name}.wif`, primary: n.name.toLowerCase() === primary, minted: !!Number(n.minted), theme: Number(n.theme ?? 0), listing: l ? { price: Number(l.price), private: l.buyer_id !== null } : null } }),
      offersIn: offersIn.map(o => ({ id: Number(o.id), name: o.name, buyer: o.buyer, price: Number(o.price), expiresAt: Number(o.expires_at) })),
      offersOut: offersOut.map(o => ({ id: Number(o.id), name: o.name, price: Number(o.price), expiresAt: Number(o.expires_at) })),
    })
  })
  const ownName = async (uid: number, name: string) => {
    const n = await one<{ name: string; owner_id: number }>('SELECT name, owner_id FROM names WHERE name = ?', [name])
    if (!n) return fail(404, 'no one holds that name')
    if (Number(n.owner_id) !== uid) fail(403, 'you don’t hold that name')
    return n.name
  }
  /** Hold an extra name (mints on WiflyNames once it is live). Up to 3 extras for now. */
  app.post('/api/names/claim', async c => {
    const uid = needUser(c)
    // No names contract on the live site: nothing to pay into, so no claims (and no free "you hold it" records).
    if (!namesContract() && !demoSeedAllowed()) fail(403, 'claiming .wif names opens soon. your @name is free and already yours.')
    await rateLimit(`nc:${uid}`, 20, 60_000)
    const { name, txHash, theme, primary: makePrimary } = await c.req.json<{ name: string; txHash?: string; theme?: number; primary?: boolean }>()
    const t = theme == null ? 0 : Number(theme)
    if (!Number.isInteger(t) || t < 0 || t > MAX_THEME) fail(400, 'pick white or green')
    const chk = await checkName(String(name ?? ''), uid)
    // the tx confirms before this call, so a live claim of your own wallet reads 'yours' here. That used to be
    // a 409 ("that name isn't free"), and the claim never reached the mirror. Now it's recorded (and made primary).
    if (chk.reason === 'yours' && namesContract()) {
      const prev0 = await primaryOf(uid)
      if (!prev0 || makePrimary) await adoptName(uid, chk.name, h.notify)
      return c.json({ ok: true, name: chk.name, display: chk.display, claimFee: nameClaimFee(chk.name), primary: (!prev0 || makePrimary) ? chk.name : prev0, pending: false, me: await h.me(uid) }, 201)
    }
    if (!chk.available && namesContract() && isTx(txHash) && !chk.owner && !(await one('SELECT 1 FROM names WHERE name = ?', [chk.name])) && await claimedIn(txHash!, chk.name)) {
      // claimed onchain by a wallet this account hasn't linked yet: keep it pending; it lands once that wallet is linked
      await run('INSERT OR IGNORE INTO names (name, owner_id, created_at, theme) VALUES (?, ?, ?, ?)', [chk.name, uid, now(), t])
      return c.json({ ok: true, name: chk.name, display: chk.display, claimFee: nameClaimFee(chk.name), primary: await primaryOf(uid), pending: true, me: await h.me(uid) }, 202)
    }
    if (!chk.available) fail(409, chk.reason === 'yours' ? 'you already hold it' : chk.reason === 'invalid' ? chk.message! : 'that name isn’t free')
    const n = await one<{ n: number }>('SELECT COUNT(*) AS n FROM names WHERE owner_id = ?', [uid])
    if (Number(n?.n ?? 0) >= 4) fail(409, 'you can hold up to 4 names for now')
    // Live: the claim is a WiflyNames.claim tx the user already sent; the indexer flips minted once ownerOf agrees.
    if (namesContract() && !isTx(txHash)) fail(400, 'claim it onchain first, then share the tx hash')
    await run('INSERT INTO names (name, owner_id, created_at, theme) VALUES (?, ?, ?, ?)', [chk.name, uid, now(), t])
    // Live: a pending row only. No @name, pill or bump on the client's word; that waits for ownerOfName (sweep / reconcile).
    if (namesContract()) return c.json({ ok: true, name: chk.name, display: chk.display, claimFee: nameClaimFee(chk.name), primary: await primaryOf(uid), pending: true, me: await h.me(uid) }, 201)
    // "Make it yours onchain" is multicall([claim, setPrimary]); the first claim is primary anyway (WiflyNames _mintName).
    const prev = await primaryOf(uid)
    if (!prev || makePrimary) await adoptName(uid, chk.name, h.notify)
    else await wifClaimed(chk.name, uid, h.notify)
    return c.json({ ok: true, name: chk.name, display: chk.display, claimFee: nameClaimFee(chk.name), primary: (!prev || makePrimary) ? chk.name : prev, pending: false, me: await h.me(uid) }, 201)
  })
  app.post('/api/names/:name/list', async c => {
    const uid = needUser(c)
    const name = await ownName(uid, c.req.param('name'))
    const { price, buyer } = await c.req.json<{ price?: number; buyer?: string }>().catch(() => ({} as { price?: number; buyer?: string }))
    let buyerId: number | null = null
    if (buyer) { const b = await one<{ id: number }>('SELECT id FROM users WHERE handle = ? COLLATE NOCASE', [buyer]); if (!b) fail(404, 'no one here by that name'); buyerId = Number(b!.id) }
    // live: the listing is the onchain one (seller and price read from WiflyNames.listings), never the client's numbers
    if (namesContract()) {
      if (!(await mirrorListing(name, uid, buyerId))) fail(409, 'that listing isn’t onchain yet. send the list transaction first')
      const row = await one<ListingRow>('SELECT * FROM name_listings WHERE name = ?', [name])
      return c.json({ ok: true, listing: (await listingJson([row!], uid))[0] })
    }
    const p = money(price)
    await run(`INSERT INTO name_listings (name, seller_id, price, buyer_id, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET price = excluded.price, buyer_id = excluded.buyer_id, seller_id = excluded.seller_id, created_at = excluded.created_at, seed = 0`, [name, uid, p, buyerId, now()])
    const row = await one<ListingRow>('SELECT * FROM name_listings WHERE name = ?', [name])
    return c.json({ ok: true, listing: (await listingJson([row!], uid))[0] })
  })
  app.delete('/api/names/:name/list', async c => {
    const uid = needUser(c)
    const name = await ownName(uid, c.req.param('name'))
    if (namesContract()) {
      const l = await chainListing(name)
      if (l === undefined) fail(503, 'couldn’t read the chain just now. try again in a minute')
      if (l && (await walletsOfUser(uid)).has(l.seller)) fail(409, 'it’s still listed onchain. cancel it in your wallet first')
    }
    await run('DELETE FROM name_listings WHERE name = ? AND seller_id = ?', [name, uid])
    return c.json({ ok: true })
  })
  /** A purchase is a WiflyNames.buy transaction. With its tx hash it is recorded as pending; ownership moves when sync reads ownerOf. */
  app.post('/api/names/:name/buy', async c => {
    const uid = needUser(c)
    const l = await one<ListingRow>('SELECT * FROM name_listings WHERE name = ?', [c.req.param('name')])
    if (!l) return fail(404, 'that name isn’t for sale')
    if (Number(l.seller_id) === uid) fail(400, 'that’s your own listing')
    const { txHash } = await c.req.json<{ txHash?: string }>().catch(() => ({ txHash: undefined }))
    if (!namesContract()) fail(503, 'the names contract isn’t live yet, so nothing can be bought')
    if (!isTx(txHash)) fail(400, 'send the purchase onchain first, then share its tx hash')
    await run('INSERT OR IGNORE INTO name_sales (name, seller_id, buyer_id, price, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', [l.name, l.seller_id, uid, l.price, txHash!.toLowerCase(), now()])
    // ownership moves only when ownerOf agrees; the verifier sweep retries until the tx is mined
    const r = await syncName(l.name, { onlyKnown: true }).catch(() => null)
    const done = !!(await one('SELECT 1 FROM name_sales WHERE tx_hash = ? AND verified = 1', [txHash!.toLowerCase()]))
    return c.json({ ok: true, pending: !done, owner: r?.owner ?? null })
  })
  /** Offers are off-chain intents (no WIF is locked; WiflyNames has no offer escrow). Accepting lists the name onchain at the offer price and pings the buyer. */
  app.post('/api/names/:name/offers', async c => {
    const uid = needUser(c)
    await rateLimit(`no:${uid}`, 30, 60_000)
    const n = await one<{ name: string; owner_id: number }>('SELECT name, owner_id FROM names WHERE name = ?', [c.req.param('name')])
    if (!n) return fail(404, 'no one holds that name')
    if (Number(n.owner_id) === uid) fail(400, 'you already hold it')
    const { price, days } = await c.req.json<{ price: number; days?: number }>()
    const p = money(price)
    const d = Math.min(30, Math.max(1, Number(days) || 7))
    await run(`UPDATE name_offers SET status = 'replaced' WHERE name = ? AND buyer_id = ? AND status = 'open'`, [n.name, uid])
    const r = await run('INSERT INTO name_offers (name, buyer_id, price, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [n.name, uid, p, now() + d * 86400_000, now()])
    await h.notify(Number(n.owner_id), uid, 'name_offer', null, { name: n.name, price: p })
    return c.json({ ok: true, id: Number(r.lastInsertRowid) }, 201)
  })
  app.delete('/api/names/offers/:id', async c => {
    const uid = needUser(c)
    await run(`UPDATE name_offers SET status = 'cancelled' WHERE id = ? AND buyer_id = ? AND status = 'open'`, [Number(c.req.param('id')), uid])
    return c.json({ ok: true })
  })
  app.post('/api/names/offers/:id/accept', async c => {
    const uid = needUser(c)
    const o = await one<{ id: number; name: string; buyer_id: number; price: number; owner_id: number }>(`SELECT o.id, o.name, o.buyer_id, o.price, n.owner_id FROM name_offers o
      JOIN names n ON n.name = o.name WHERE o.id = ? AND o.status = 'open' AND o.expires_at > ?`, [Number(c.req.param('id')), now()])
    if (!o) return fail(404, 'that offer is gone')
    if (Number(o.owner_id) !== uid) fail(403, 'you don’t hold that name')
    if ((await primaryOf(uid)) === String(o.name).toLowerCase()) fail(409, 'that’s your primary .wif. pick another primary first')
    if (namesContract()) { if (!(await mirrorListing(o.name, uid, Number(o.buyer_id)))) fail(409, 'list it onchain at the offer price first') }
    else await run(`INSERT INTO name_listings (name, seller_id, price, buyer_id, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET price = excluded.price, buyer_id = excluded.buyer_id, created_at = excluded.created_at, seed = 0`, [o.name, uid, o.price, o.buyer_id, now()])
    await run(`UPDATE name_offers SET status = 'accepted' WHERE id = ?`, [o.id])
    await h.notify(Number(o.buyer_id), uid, 'name_offer_accepted', null, { name: o.name, price: Number(o.price) })
    return c.json({ ok: true })
  })
  app.get('/api/names/check', async c => {
    await rateLimit(`nk:${c.get('uid') ?? clientIp(c)}`, 120, 60_000)
    return c.json(await checkName(c.req.query('n') ?? '', c.get('uid')))
  })
  /** name.wif → wallet. Always the wallet that owns or is set on the name, never whoever has the matching @handle. */
  app.get('/api/names/resolve/:name', async c => {
    const n = c.req.param('name').toLowerCase().replace(/\.wif$/, '')
    const r = await resolveName(n)
    if (!r) return fail(404, `${n}.wif isn’t claimed`)
    const holder = await one<{ id: number }>('SELECT owner_id AS id FROM names WHERE name = ?', [n])
    const owner = holder ? (await hydrateUsers([Number(holder.id)], c.get('uid'))).get(Number(holder.id)) : null
    return c.json({ name: n, display: `${n}.wif`, address: r.address, source: r.source, owner: owner ? { handle: owner.handle, name: owner.name, avatar: owner.avatar, tone: owner.tone, wifName: owner.wifName } : null })
  })
  /** reverseName(address): the primary .wif of a wallet. */
  app.get('/api/names/reverse/:address', async c => {
    const a = c.req.param('address').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(a)) fail(400, 'not an address')
    const addr = namesContract()
    if (addr) {
      try { const n = await rpcCached(`ns:reverse:${a}`, 30_000, () => chainClient().readContract({ address: addr as Address, abi: NS_ABI, functionName: 'reverseName', args: [a as Address] })); const label = n ? n.replace(/\.wif$/, '') : null; return c.json({ address: a, name: label, display: label ? `${label}.wif` : null, source: 'chain' }) } catch { /* fall through */ }
    }
    const u = await one<{ id: number }>(`SELECT id FROM users WHERE address = ? UNION SELECT user_id AS id FROM privy_accounts WHERE wallet = ? LIMIT 1`, [a, a])
    const label = u ? await primaryOf(Number(u.id)) : null
    return c.json({ address: a, name: label, display: label ? `${label}.wif` : null, source: 'mirror' })
  })
  /** Card theme (WiflyNames.setTheme, owner only): 0 default, 1 white, 2 green. Live, it mirrors the tx; kept on sale. */
  app.post('/api/names/:name/theme', async c => {
    const uid = needUser(c)
    const name = await ownName(uid, c.req.param('name').toLowerCase())
    const { theme, txHash } = await c.req.json<{ theme: number; txHash?: string }>().catch(() => ({ theme: -1, txHash: undefined }))
    const t = Number(theme)
    if (!Number.isInteger(t) || t < 0 || t > MAX_THEME) fail(400, 'pick white or green')
    if (namesContract() && !isTx(txHash)) fail(400, 'set it onchain first, then share the tx hash')
    await run('UPDATE names SET theme = ? WHERE name = ?', [t, name])
    return c.json({ ok: true, name, theme: t })
  })
  app.post('/api/names/:name/primary', async c => {
    const uid = needUser(c)
    const name = await ownName(uid, c.req.param('name').toLowerCase())
    if (await one('SELECT 1 FROM name_listings WHERE name = ?', [name])) fail(409, 'delist it before you make it your primary')
    await adoptName(uid, name, h.notify)
    return c.json({ ok: true, primary: name.toLowerCase(), me: await h.me(uid) })
  })
  /** Change name: switch your primary .wif (it becomes your @username), then keep the old one or list it for sale. */
  app.post('/api/me/name', async c => {
    const uid = needUser(c)
    const b = await c.req.json<{ name?: string; old?: 'keep' | 'list'; price?: number }>().catch(() => ({} as { name?: string; old?: 'keep' | 'list'; price?: number }))
    const name = await ownName(uid, String(b.name ?? '').toLowerCase())
    if (await one('SELECT 1 FROM name_listings WHERE name = ?', [name])) fail(409, 'delist it before you make it your primary')
    const prev = await primaryOf(uid)
    if (prev === name.toLowerCase()) fail(409, 'that’s already your name')
    const price = b.old === 'list' ? money(b.price) : 0
    await adoptName(uid, name, h.notify)
    if (b.old === 'list' && prev && namesContract()) await mirrorListing(prev, uid) // only if the list tx already landed
    else if (b.old === 'list' && prev)
      await run(`INSERT INTO name_listings (name, seller_id, price, buyer_id, created_at) VALUES (?, ?, ?, NULL, ?)
        ON CONFLICT(name) DO UPDATE SET price = excluded.price, buyer_id = NULL, seller_id = excluded.seller_id, created_at = excluded.created_at, seed = 0`, [prev, uid, price, now()])
    clearRankCache()
    return c.json({ ok: true, primary: name.toLowerCase(), old: prev ? { name: prev, listed: b.old === 'list', price: price || null } : null, me: await h.me(uid) })
  })
  /** Records (address via setAddr; text keys avatar, x, url, bio via setText). Owner only; live, they mirror setText/setAddr txs. Reset on sale. */
  app.put('/api/names/:name/records', async c => {
    const uid = needUser(c)
    const name = await ownName(uid, c.req.param('name').toLowerCase())
    const b = await c.req.json<Partial<Record<'address' | 'avatar' | 'x' | 'url' | 'bio', string | null>>>().catch(() => ({} as Record<string, never>))
    const clean = (v: unknown, max: number) => { const t = v == null ? '' : String(v).trim(); if (charCount(t) > max || bytesOf(t) > MAX_TEXT_BYTES) fail(400, `keep it under ${Math.min(max, MAX_TEXT_BYTES)} characters`); return t || null }
    const address = clean(b.address, 42)?.toLowerCase() ?? null
    if (address && !/^0x[0-9a-f]{40}$/.test(address)) fail(400, 'that isn’t a wallet address')
    const avatar = clean(b.avatar, 300)
    if (avatar && !/^(\/uploads\/[A-Za-z0-9_-]+\.(png|jpg|gif|webp)|https:\/\/\S+|ipfs:\/\/\S+)$/.test(avatar)) fail(400, 'avatar must be an upload, https or ipfs link')
    const x = clean(b.x, 16)?.replace(/^@/, '') ?? null
    if (x && !/^[A-Za-z0-9_]{1,15}$/.test(x)) fail(400, 'that isn’t an X handle')
    const url = clean(b.url, MAX_TEXT_BYTES)
    if (url && !/^https:\/\/\S+$/.test(url)) fail(400, 'links start with https://')
    const bio = clean(b.bio, MAX_TEXT_BYTES)
    if (bio && bytesOf(bio) > MAX_TEXT_BYTES) fail(400, 'bios are up to 256 bytes')
    await run(`INSERT INTO name_records (name, address, avatar, x, url, bio, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET address = excluded.address, avatar = excluded.avatar, x = excluded.x, url = excluded.url, bio = excluded.bio, updated_at = excluded.updated_at`,
      [name, address, avatar, x, url, bio, now()])
    return c.json({ ok: true, records: await recordsOf(name) })
  })
  /** Public name page data (alice.wif). */
  // name card art from the onchain WiflyNameRenderer (deployed: read from chain; before deploy: same bytecode, in-process)
  app.get('/api/names/art/:file', async c => {
    const n = c.req.param('file').replace(/\.svg$/i, '').replace(/\.wif$/i, '').trim().toLowerCase()
    if (!/^[a-z0-9_]{1,32}$/.test(n)) fail(400, 'bad name')
    const rare = n.length <= 4, reserved = RESERVED.has(n)
    // ?t=0|1|2 previews a theme (picker); otherwise the stored theme of a claimed name (mirror of WiflyNames.theme).
    const q = c.req.query('t')
    let theme = q != null && /^[0-2]$/.test(q) ? Number(q) : -1
    const held = await one<{ theme: number }>('SELECT theme FROM names WHERE name = ?', [n])
    if (theme < 0) theme = Number(held?.theme ?? 0)
    const ra = namesRendererContract()
    let svg: string
    try {
      svg = await renderNameSvg(n, rare, reserved, ra ? async data => (await chainClient().call({ to: ra as Address, data })).data ?? '0x' : undefined, theme)
    } catch { svg = await renderNameSvg(n, rare, reserved, undefined, theme) }
    if (!held) svg = unclaimedPreview(svg) // nobody holds it yet: no token id line
    c.header('content-type', 'image/svg+xml; charset=utf-8')
    c.header('cache-control', q != null ? 'public, max-age=86400' : 'public, max-age=60')
    c.header('x-wifly-art-source', ra ? 'chain' : 'compiled-renderer')
    return c.body(svg)
  })

  app.get('/api/names/:name', async c => {
    const n = c.req.param('name').toLowerCase().replace(/\.wif$/, '')
    return c.json(await cached(['names'], `nv:${c.get('uid') ?? 0}:${n}`, 15_000, () => nameView(n, c.get('uid'))))
  })
  async function nameView(n: string, uid: number | null) {
    const c = { get: (_: 'uid') => uid, json: <T,>(v: T) => v }
    const row = await one<{ name: string; owner_id: number; minted: number; created_at: number; theme: number }>('SELECT * FROM names WHERE name = ?', [n])
    if (!row) { const chk = await checkName(n, c.get('uid')); return c.json({ name: n, display: `${n}.wif`, claimed: false, check: chk }) }
    const owner = (await hydrateUsers([Number(row.owner_id)], c.get('uid'))).get(Number(row.owner_id))
    const l = (await all<ListingRow>('SELECT * FROM name_listings WHERE name = ?', [n]))
    const r = await resolveName(n)
    return c.json({
      name: row.name, display: `${row.name}.wif`, claimed: true, minted: !!Number(row.minted), theme: Number(row.theme ?? 0), since: Number(row.created_at), tokenId: nameTokenId(row.name).toString(),
      owner, primary: owner?.wifName === row.name.toLowerCase(), mine: Number(row.owner_id) === c.get('uid'),
      address: r?.address ?? null, source: r?.source ?? 'mirror', records: await recordsOf(row.name),
      listing: l.length ? (await listingJson(l, c.get('uid')))[0] : null, live: !!namesContract(),
    })
  }
  /** Mirror the owner from WiflyNames.ownerOf. Answers 503 until the contract address is set. */
  app.post('/api/names/:name/sync', async c => {
    needUser(c)
    if (!namesContract()) return fail(503, 'the names contract isn’t live yet')
    const r = await syncName(c.req.param('name'))
    if (!r) return fail(404, 'not minted onchain')
    return c.json({ ok: true, ...r })
  })

  // ---- creator tiers
  app.put('/api/me/tiers', async c => {
    const uid = needUser(c)
    const { tiers } = await c.req.json<{ tiers: { name: string; price: number; perks?: string[] }[] }>()
    if (!Array.isArray(tiers) || tiers.length > 3) fail(400, 'up to 3 tiers')
    const clean = tiers.map((t, i) => {
      const name = String(t.name ?? '').trim()
      if (!name || charCount(name) > 24) fail(400, 'tier names are 1–24 characters')
      const perks = (Array.isArray(t.perks) ? t.perks : []).map(p => String(p).trim()).filter(Boolean).slice(0, 5)
      if (perks.some(p => charCount(p) > 60)) fail(400, 'perks are up to 60 characters')
      return { id: `t${i + 1}`, name, price: money(t.price, 1e7), perks }
    })
    for (let i = 1; i < clean.length; i++) if (clean[i].price <= clean[i - 1].price) fail(400, 'each tier should cost more than the one before')
    if (clean.length) await run(`UPDATE users SET extras = json_set(extras, '$.tiers', json(?)), creator = 1 WHERE id = ?`, [JSON.stringify(clean), uid])
    else await run(`UPDATE users SET extras = json_remove(extras, '$.tiers') WHERE id = ?`, [uid])
    return c.json({ me: await h.me(uid) })
  })

  // ---- Plus
  app.get('/api/plus', async c => {
    const uid = c.get('uid')
    if (uid) await lazyPlusSync(uid)
    return c.json(uid ? { ...(await plusView(uid)), wallet: plusWalletOf(uid) } : { state: 'none', plan: 'month', price: plusPlans().month.price, plans: Object.values(plusPlans()), graceDays: PLUS_GRACE_MS / 86400_000, signedOut: true })
  })
  /** Opt in with an agreed price (at least the current plan price), or turn off (stops renewals at once). */
  app.post('/api/plus/auto-renew', async c => {
    const uid = needUser(c)
    const b = await c.req.json<{ on: boolean; agreedPrice?: number; plan?: PlusPlan }>()
    const plans = plusPlans()
    if (!b.on) {
      await run('UPDATE plus_subs SET auto_renew = 0, updated_at = ? WHERE user_id = ?', [now(), uid])
      return c.json(await plusView(uid))
    }
    let v = await plusView(uid)
    // the mirror may lag the chain (a sub paid a moment ago, or from another wallet on the account): read the chain first
    if (v.state === 'none') { await syncPlusFromChain(uid); v = await plusView(uid) }
    if (v.state === 'none') fail(409, 'get plus first, then turn on auto-renew')
    const plan: PlusPlan = b.plan === 'year' ? 'year' : b.plan === 'month' ? 'month' : v.plan
    const agreed = money(b.agreedPrice, 1e8)
    if (agreed < plans[plan].price) fail(400, `the ${plan === 'year' ? 'yearly' : 'monthly'} price is ${plans[plan].price.toLocaleString('en-US')} wif. agree to at least that`)
    await run(`INSERT INTO plus_subs (user_id, plan, auto_renew, agreed_price, updated_at) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, auto_renew = 1, agreed_price = excluded.agreed_price, updated_at = excluded.updated_at`, [uid, plan, agreed, now()])
    return c.json(await plusView(uid))
  })
  /** Record a Plus purchase or manual renewal tx (pending until the indexer verifies it against the Wifly contract). */
  app.post('/api/plus/payments', async c => {
    const uid = needUser(c)
    const b = await c.req.json<{ plan?: PlusPlan; txHash?: string; kind?: 'buy' | 'renew' }>()
    if (!wiflyContract()) fail(503, 'the wifly contract isn’t live yet, so nothing was paid')
    if (!isTx(b.txHash)) fail(400, 'send the payment onchain first, then share its tx hash')
    const plan: PlusPlan = b.plan === 'year' ? 'year' : 'month'
    const hash = b.txHash!.toLowerCase()
    await run('INSERT OR IGNORE INTO plus_payments (user_id, kind, plan, price, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', [uid, b.kind === 'renew' ? 'renew' : 'buy', plan, plusPlans()[plan].price, hash, now()])
    // the server checks the chain itself: the receipt (confirmed, to Wifly, from a wallet on this account), then subStatus
    // for every wallet on the account, so plus turns on right away whichever wallet paid
    const verified = await verifyPlusTx(uid, hash as `0x${string}`)
    if (verified) await run('UPDATE plus_payments SET verified = 1 WHERE tx_hash = ? AND user_id = ?', [hash, uid])
    const sync = await syncPlusFromChain(uid)
    const view = await plusView(uid)
    return c.json({ ok: true, verified, pending: !view.check, plus: { ...view, wallet: sync.wallet }, me: await h.me(uid), ...(sync.reason ? { note: sync.reason } : {}) })
  })
  /** Re-read Plus from the chain for every wallet on this account (the page calls it after a payment confirms). */
  app.post('/api/plus/sync', async c => {
    const uid = needUser(c)
    rateLimit(`plus-sync:${uid}`, 20, 60_000)
    const sync = await syncPlusFromChain(uid)
    return c.json({ ok: sync.synced, plus: { ...(await plusView(uid)), wallet: sync.wallet }, me: await h.me(uid), ...(sync.reason ? { note: sync.reason } : {}) })
  })

  // ---- badges
  app.get('/api/badges/:handle', async c => {
    const u = await one<{ id: number }>('SELECT id FROM users WHERE handle = ? COLLATE NOCASE', [c.req.param('handle')])
    if (!u) return fail(404, 'no one here by that name')
    return c.json({ ...(await badgeView(Number(u.id))), live: !!badgesContract() })
  })
  app.post('/api/badges/burns', async c => {
    const uid = needUser(c)
    const b = await c.req.json<{ amount: number; txHash?: string }>()
    const amount = money(b.amount, 1e10)
    if (!badgesContract()) fail(503, 'the badges contract isn’t live yet, so nothing was burned')
    if (!isTx(b.txHash)) fail(400, 'burn onchain first, then share its tx hash')
    await run('INSERT OR IGNORE INTO badge_burns (user_id, amount, tx_hash, created_at) VALUES (?, ?, ?, ?)', [uid, amount, b.txHash!.toLowerCase(), now()])
    const verified = await (await import('./verify')).verifyBurn(b.txHash!).catch(() => false)
    return c.json({ ok: true, pending: !verified, verified })
  })
}
