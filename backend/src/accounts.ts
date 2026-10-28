/**
 * who owns a wallet, soft account deletion, the owner-only accounts list, and short failure logs.
 *
 * - uidForWallet: users.address, user_wallets (linked or guest) and the Privy embedded wallet (privy_accounts.wallet).
 *   The Privy wallet used to be missed, so a .wif claimed with it never reached the mirror.
 * - softDeleteUser: the row is backed up, the profile anonymized, drops hidden, the @name freed, X / email / wallets
 *   unlinked so they can start a new account, and every session for the old id stops working. Onchain items stay put.
 * - Logs never carry tokens, signatures, cookies, emails or full wallet addresses.
 */
import { createHash } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { all, one, run, writeTx } from './db'
import { pendingHandle } from './pending'

const now = () => Date.now()
const lc = (a: string | null | undefined) => String(a ?? '').toLowerCase()

/** The live (not deleted) account that signs in with or holds this wallet, if any. */
export async function uidForWallet(address: string): Promise<number | null> {
  const a = lc(address)
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null
  const r = await one<{ id: number }>(`SELECT id FROM users WHERE address = ? AND deleted_at IS NULL
    UNION ALL SELECT w.user_id FROM user_wallets w JOIN users u ON u.id = w.user_id WHERE w.address = ? AND u.deleted_at IS NULL
    UNION ALL SELECT p.user_id FROM privy_accounts p JOIN users u ON u.id = p.user_id WHERE p.wallet = ? AND u.deleted_at IS NULL LIMIT 1`, [a, a, a])
  return r ? Number(r.id) : null
}
/** Every wallet of an account: main address, linked and guest wallets, and the Privy embedded wallet. */
export async function walletsOfUser(uid: number): Promise<Set<string>> {
  const rows = await all<{ a: string | null }>(`SELECT address AS a FROM users WHERE id = ? UNION SELECT address FROM user_wallets WHERE user_id = ?
    UNION SELECT wallet FROM privy_accounts WHERE user_id = ?`, [uid, uid, uid])
  return new Set(rows.map(r => lc(r.a)).filter(Boolean))
}

/** A guest: signed up with a browser guest key and has no linked wallet, x or email yet. */
export async function isGuestAccount(uid: number): Promise<boolean> {
  const u = await one<{ extras: string | null }>('SELECT extras FROM users WHERE id = ?', [uid])
  let ex: { guest?: number } = {}; try { ex = JSON.parse(u?.extras || '{}') } catch { /* keep */ }
  if (!ex.guest) return false
  const linked = await one(`SELECT 1 FROM user_wallets WHERE user_id = ? AND kind IN ('linked', 'privy')
    UNION ALL SELECT 1 FROM privy_accounts WHERE user_id = ? LIMIT 1`, [uid, uid])
  return !linked
}

/** Writes a guest may still make: sign in, link, sign out, set up the profile, avatar, quiet personal choices. */
const GUEST_OK = /^\/api\/(auth\/.+|me|me\/delete|onboarding|uploads|notifications\/read|drops\/[^/]+\/(bookmark|not-interested)|users\/[^/]+\/mute|companion\/chat|dca\/parse)$/
export const LINK_REQUIRED = { error: 'link a wallet, x or email to continue', code: 'link_required' } as const
/** Every other write from a guest is a 403 with code 'link_required'. Reads stay open. */
export const guestWriteGate: MiddlewareHandler = async (c, next) => {
  const uid = c.get('uid') as number | undefined
  const m = c.req.method
  if (!uid || m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || GUEST_OK.test(c.req.path)) return next()
  if (await isGuestAccount(uid)) return c.json(LINK_REQUIRED, 403)
  return next()
}

// ------------------------------------------------------------------ logs

/** 6 hex chars of a hash: enough to follow one account through the logs, not enough to look it up. */
export const shortId = (v: unknown) => (v == null || v === '' ? '-' : createHash('sha256').update(String(v)).digest('hex').slice(0, 6))
export const shortAddr = (a: string | null | undefined) => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || null)
export const maskEmail = (e: string | null | undefined) => {
  if (!e || !e.includes('@')) return null
  const [u, d] = e.split('@'); const dot = d.lastIndexOf('.')
  return `${u.slice(0, 1)}•••@${d.slice(0, 1)}•••${dot > 0 ? d.slice(dot) : ''}`
}
/** Plain words only: a short reason code from the error text (no names, numbers, addresses or tokens survive). */
export const reasonCode = (msg: unknown) => String(msg ?? '').toLowerCase().replace(/0x[0-9a-f]+|[^a-z ]+/g, ' ').trim().split(/\s+/).slice(0, 4).join('_').slice(0, 32) || 'unknown'

const WATCHED = /^\/api\/(auth\/|me(\/|$)|onboarding$|names\/claim$|admin\/)/
let logSink: (line: string) => void = l => console.warn(l)
export function setLogSink(f: ((line: string) => void) | null) { logSink = f ?? (l => console.warn(l)) }
export const logEvent = (line: string) => logSink(line)
/** One line per failed sign-in, link, /me, onboarding, claim or admin request: route, status, reason code, short user id. */
export const failLog: MiddlewareHandler = async (c, next) => {
  await next()
  const s = c.res.status
  if (s < 400 || !WATCHED.test(c.req.path)) return
  let reason = String(s)
  try { const b = await c.res.clone().json() as { error?: string }; if (b?.error) reason = reasonCode(b.error) } catch { /* not json */ }
  logSink(`[req-fail] ${c.req.method} ${c.req.path.replace(/\/0x[0-9a-fA-F]+/g, '/0x…').slice(0, 60)} ${s} ${reason} u=${shortId((c as Context).get('uid'))}`)
}

// ------------------------------------------------------------------ delete

/** Soft delete. Keeps a JSON backup of the row; frees everything that lets a person sign in or be found. */
export async function softDeleteUser(uid: number, by: { actor: 'self' | 'admin'; adminUid?: number }) {
  const u = await one<Record<string, unknown>>('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [uid])
  if (!u) return false
  const extra = {
    wallets: await all('SELECT address, kind FROM user_wallets WHERE user_id = ?', [uid]),
    privy: await all('SELECT did, x_user_id, x_username, wallet FROM privy_accounts WHERE user_id = ?', [uid]), // no email in the backup
    names: await all('SELECT name, minted FROM names WHERE owner_id = ?', [uid]),
  }
  const t = now()
  await writeTx(async exec => {
    await exec('INSERT INTO deleted_users (user_id, row_json, by_actor, admin_id, deleted_at) VALUES (?, ?, ?, ?, ?)', [uid, JSON.stringify({ user: u, ...extra }), by.actor, by.adminUid ?? null, t])
    await exec(`UPDATE users SET handle = ?, name = '', bio = '', avatar = NULL, location = NULL, address = NULL, plus = 0, creator = 0,
      extras = '{"deleted":1}', onboarded = 0, deleted_at = ? WHERE id = ?`, [pendingHandle(), t, uid])
    await exec('UPDATE drops SET deleted = 1 WHERE author_id = ?', [uid])
    await exec('DELETE FROM privy_accounts WHERE user_id = ?', [uid])
    await exec('DELETE FROM user_wallets WHERE user_id = ?', [uid])
    // the NFTs stay in the wallet; the mirror forgets them and re-learns them if that wallet signs up again
    await exec('DELETE FROM name_listings WHERE seller_id = ?', [uid])
    await exec("UPDATE name_offers SET status = 'cancelled' WHERE buyer_id = ? AND status = 'open'", [uid])
    await exec('DELETE FROM name_records WHERE name IN (SELECT name FROM names WHERE owner_id = ?)', [uid])
    await exec('DELETE FROM names WHERE owner_id = ?', [uid])
    await exec('DELETE FROM handle_history WHERE user_id = ?', [uid])
    await exec('DELETE FROM handle_bumps WHERE user_id = ? OR owner_id = ?', [uid, uid])
    await exec('DELETE FROM follows WHERE follower_id = ? OR followee_id = ?', [uid, uid])
    await exec('DELETE FROM notifications WHERE user_id = ? OR actor_id = ?', [uid, uid])
  })
  return true
}

// ------------------------------------------------------------------ admin

/** ADMIN_ADDRESSES (comma-separated wallets). Empty = the admin pages don't exist for anyone. */
export const adminAddresses = () => new Set((process.env.ADMIN_ADDRESSES || '').split(',').map(s => s.trim().toLowerCase()).filter(a => /^0x[0-9a-f]{40}$/.test(a)))
export async function isAdmin(uid: number | null): Promise<boolean> {
  const set = adminAddresses()
  if (!uid || !set.size) return false
  for (const w of await walletsOfUser(uid)) if (set.has(w)) return true
  return false
}
export async function audit(adminUid: number, action: string, targetUid: number | null, detail: object = {}) {
  await run('INSERT INTO admin_audit (admin_id, action, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?)', [adminUid, action, targetUid, JSON.stringify(detail), now()])
  logSink(`[admin] ${action} by=${shortId(adminUid)} target=${shortId(targetUid)}`)
}

export type AccountRow = { id: number; handle: string | null; methods: string[]; onboarded: boolean; wallet: string | null; x: string | null; email: string | null; createdAt: number; posts: number }
export async function listAccounts(f: { filter?: 'all' | 'unfinished' | 'guests'; limit?: number; before?: number }): Promise<AccountRow[]> {
  const rows = await all<{ id: number; handle: string; address: string | null; onboarded: number; extras: string | null; created_at: number; x_username: string | null; email: string | null; pwallet: string | null; guest: number; linked: number; posts: number }>(
    `SELECT u.id, u.handle, u.address, u.onboarded, u.extras, u.created_at, p.x_username, p.email, p.wallet AS pwallet,
      (SELECT COUNT(*) FROM user_wallets w WHERE w.user_id = u.id AND w.kind = 'guest') AS guest,
      (SELECT COUNT(*) FROM user_wallets w WHERE w.user_id = u.id AND w.kind = 'linked') AS linked,
      (SELECT COUNT(*) FROM drops d WHERE d.author_id = u.id AND d.deleted = 0) AS posts
     FROM users u LEFT JOIN privy_accounts p ON p.user_id = u.id
     WHERE u.deleted_at IS NULL AND u.seed = 0 AND u.created_at < ? ORDER BY u.created_at DESC LIMIT ?`, [f.before ?? 8.64e15, Math.min(200, f.limit ?? 100)])
  const out = rows.map(r => {
    let ex: { guest?: number } = {}; try { ex = JSON.parse(r.extras || '{}') } catch { /* keep */ }
    const isGuest = !!ex.guest && !Number(r.linked) && !r.x_username && !r.email
    const methods = [r.x_username && 'x', r.email && 'email', (Number(r.linked) || (r.address && !ex.guest && r.address !== r.pwallet)) && 'wallet', (ex.guest || Number(r.guest)) && 'guest'].filter(Boolean) as string[]
    const unfinished = !Number(r.onboarded) || r.handle.startsWith('~')
    return { id: Number(r.id), handle: unfinished && r.handle.startsWith('~') ? null : r.handle, methods, onboarded: !unfinished, wallet: shortAddr(r.address ?? r.pwallet), x: r.x_username, email: maskEmail(r.email), createdAt: Number(r.created_at), posts: Number(r.posts), _guest: isGuest }
  })
  const pick = f.filter === 'unfinished' ? out.filter(r => !r.onboarded) : f.filter === 'guests' ? out.filter(r => r._guest) : out
  return pick.map(({ _guest, ...r }) => r)
}
