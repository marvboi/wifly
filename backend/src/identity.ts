/**
 * Names on Wifly:
 *  - Sign-up gives a FREE @name (users.handle): unique, case-insensitive, same charset as .wif, not an NFT.
 *  - A .wif is an optional paid upgrade. Anyone can claim any free .wif onchain (no reservation, no first dibs).
 *  - Owning x.wif always wins @x. If a free @x holder exists when x.wif gets claimed by someone else, they're "bumped":
 *    a gentle notice and a rename step, keeping @x for GRACE_MS. Then they move to a fallback and the owner gets @x.
 *    Posts, followers, badges and subs never move: accounts are keyed by id (the wallet), not by name.
 *  - .wif owners keep the name switch: the profile shows "formerly old.wif" for 30 days and old @links redirect
 *    until the old name has a new owner or someone else uses it as their @name.
 */
import { one, run, all } from './db'
import { fail } from './util'

export const FORMERLY_MS = 30 * 24 * 3600_000
export const GRACE_MS = 7 * 24 * 3600_000

/** Pure redirect rule, kept separate so it is easy to test. */
export function redirectAllowed(x: { historyUser: number | null; activeHandleUser: number | null; nameOwner: number | null }): boolean {
  if (x.historyUser == null) return false               // never used by anyone
  if (x.activeHandleUser != null) return false          // someone uses it as their @name right now
  if (x.nameOwner != null && x.nameOwner !== x.historyUser) return false // sold or claimed by someone else
  return true
}

/** Pure rule: who should hold @name right now. Owning the .wif wins, after the bumped free holder's grace period. */
export function handleHolder(x: { freeHolder: number | null; wifOwner: number | null; bumpRenameBy: number | null; now: number }):
  { holder: number | null; bump: 'none' | 'grace' | 'expired' } {
  if (x.wifOwner == null) return { holder: x.freeHolder, bump: 'none' }
  if (x.freeHolder == null || x.freeHolder === x.wifOwner) return { holder: x.wifOwner, bump: 'none' }
  if (x.bumpRenameBy != null && x.now < x.bumpRenameBy) return { holder: x.freeHolder, bump: 'grace' }
  return { holder: x.wifOwner, bump: 'expired' }
}

const lc = (s: string) => s.trim().replace(/^@/, '').replace(/\.wif$/i, '').toLowerCase()
const usedAsHandle = async (h: string) => !!(await one('SELECT 1 FROM users WHERE handle = ? COLLATE NOCASE', [h]))
async function fallbackHandle(base: string): Promise<string> {
  const b = base.slice(0, 16)
  for (let i = 1; i < 200; i++) {
    const t = `${b}_${i}`
    if (!(await usedAsHandle(t)) && !(await one('SELECT 1 FROM names WHERE name = ?', [t])) && !(await one('SELECT 1 FROM handle_bumps WHERE handle = ? AND settled_at IS NULL', [t]))) return t
  }
  return `${b.slice(0, 10)}_${Date.now() % 1e8}`
}

/** Set a user's @name and leave a trail so old links redirect (only for real changes). */
async function moveHandle(uid: number, to: string, trail: boolean) {
  const cur = await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [uid])
  if (!cur || cur.handle.toLowerCase() === to) return
  const t = Date.now()
  if (trail && !/^wif_u\d+$/.test(cur.handle) && !cur.handle.startsWith('~')) await run('INSERT OR REPLACE INTO handle_history (old_handle, user_id, changed_at) VALUES (?, ?, ?)', [cur.handle.toLowerCase(), uid, t])
  await run('DELETE FROM handle_history WHERE old_handle = ?', [to])
  await run('UPDATE users SET handle = ? WHERE id = ?', [to, uid])
}

/**
 * x.wif now belongs to `ownerUid` (null = a wallet that isn't on Wifly yet). If someone else holds @x for free,
 * open a bump: they get a notice and GRACE_MS to rename. Returns the bumped user id, if any.
 */
export async function wifClaimed(name: string, ownerUid: number | null, notify?: (to: number, actor: number, kind: string, dropId: string | null, meta?: object) => Promise<void>): Promise<number | null> {
  const n = lc(name)
  const free = await one<{ id: number; extras: string | null }>('SELECT id, extras FROM users WHERE handle = ? COLLATE NOCASE', [n])
  if (!free || Number(free.id) === ownerUid) return null
  const open = await one('SELECT 1 FROM handle_bumps WHERE handle = ? AND user_id = ? AND settled_at IS NULL', [n, free.id])
  if (open) return null
  const t = Date.now()
  await run(`INSERT INTO handle_bumps (handle, user_id, owner_id, created_at, rename_by, settled_at) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(handle) DO UPDATE SET user_id = excluded.user_id, owner_id = excluded.owner_id, created_at = excluded.created_at, rename_by = excluded.rename_by, settled_at = NULL`,
    [n, free.id, ownerUid, t, t + GRACE_MS])
  if (notify) await notify(Number(free.id), ownerUid ?? Number(free.id), 'handle_bump', null, { handle: n, renameBy: t + GRACE_MS })
  return Number(free.id)
}

/** The open bump for a user, if any (for the notice and the rename step). */
export async function bumpOf(uid: number): Promise<{ handle: string; renameBy: number; since: number } | null> {
  const r = await one<{ handle: string; rename_by: number; created_at: number }>('SELECT handle, rename_by, created_at FROM handle_bumps WHERE user_id = ? AND settled_at IS NULL ORDER BY created_at DESC LIMIT 1', [uid])
  return r ? { handle: r.handle, renameBy: Number(r.rename_by), since: Number(r.created_at) } : null
}

/** Close bumps: the free holder renamed, or the grace ran out (then they move to a fallback). The .wif owner gets @x if it's their primary. */
export async function settleBumps(nowMs = Date.now()) {
  const open = await all<{ handle: string; user_id: number }>('SELECT handle, user_id FROM handle_bumps WHERE settled_at IS NULL')
  for (const b of open) {
    const h = b.handle.toLowerCase()
    const holder = await one<{ id: number }>('SELECT id FROM users WHERE handle = ? COLLATE NOCASE', [h])
    const stillTheirs = holder && Number(holder.id) === Number(b.user_id)
    const row = await one<{ rename_by: number }>('SELECT rename_by FROM handle_bumps WHERE handle = ?', [h])
    if (stillTheirs && nowMs < Number(row!.rename_by)) continue
    if (stillTheirs) await moveHandle(Number(b.user_id), await fallbackHandle(h), false) // no redirect: @x now belongs to the .wif owner
    await run('UPDATE handle_bumps SET settled_at = ? WHERE handle = ?', [nowMs, h])
    const owner = await one<{ owner_id: number; extras: string | null }>('SELECT n.owner_id, u.extras FROM names n JOIN users u ON u.id = n.owner_id WHERE n.name = ?', [h])
    if (owner && lc(String(JSON.parse(owner.extras || '{}').wifName ?? '')) === h && !(await usedAsHandle(h))) await moveHandle(Number(owner.owner_id), h, true)
  }
}

/** Free rename (Settings, or the bump notice). .wif owners switch their @ by switching their primary .wif instead. */
export async function renameFree(uid: number, to: string) {
  await moveHandle(uid, lc(to), true)
  await settleBumps()
}

/** Make `name` your primary .wif. You must already hold it. You get @name now, or once a bumped free holder's grace ends. */
export async function adoptName(uid: number, name: string, notify?: Parameters<typeof wifClaimed>[2]) {
  const n = lc(name)
  const held = await one<{ owner_id: number }>('SELECT owner_id FROM names WHERE name = ?', [n])
  if (!held || Number(held.owner_id) !== uid) fail(403, 'you don’t hold that name')
  const cur = await one<{ handle: string; extras: string | null }>('SELECT handle, extras FROM users WHERE id = ?', [uid])
  const prevWif = cur ? lc(String(JSON.parse(cur.extras || '{}').wifName ?? '')) : ''
  await run(`UPDATE users SET extras = json_set(COALESCE(extras, '{}'), '$.wifName', ?) WHERE id = ?`, [n, uid])
  const other = await one<{ id: number }>('SELECT id FROM users WHERE handle = ? COLLATE NOCASE AND id != ?', [n, uid])
  if (other) { await wifClaimed(n, uid, notify); return } // you get @n when their grace ends or they rename
  // Old .wif links redirect ("formerly x.wif"); a plain free @name you had before doesn't need a trail unless it was a .wif.
  const trail = !!prevWif && cur!.handle.toLowerCase() === prevWif
  await moveHandle(uid, n, trail)
}

/** Where an unknown @handle should go, if anywhere. */
export async function redirectFor(handle: string): Promise<string | null> {
  const h = handle.toLowerCase()
  const hist = await one<{ user_id: number }>('SELECT user_id FROM handle_history WHERE old_handle = ?', [h])
  const active = await one<{ id: number }>('SELECT id FROM users WHERE handle = ? COLLATE NOCASE', [h])
  const owner = await one<{ owner_id: number }>('SELECT owner_id FROM names WHERE name = ?', [h])
  // Owning x.wif means you hold @x: with nobody on @x, /@x goes to the owner's profile.
  if (!active && owner && (!hist || Number(hist.user_id) !== Number(owner.owner_id))) {
    const o = await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [owner.owner_id])
    return o && o.handle.toLowerCase() !== h ? o.handle : null
  }
  if (!redirectAllowed({ historyUser: hist ? Number(hist.user_id) : null, activeHandleUser: active ? Number(active.id) : null, nameOwner: owner ? Number(owner.owner_id) : null })) return null
  const to = await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [hist!.user_id])
  return to?.handle ?? null
}

/** The .wif you switched away from in the last 30 days, if any (only .wif names; free @names don't get the label). */
export async function formerlyOf(uid: number): Promise<{ name: string; until: number } | null> {
  const r = await one<{ old_handle: string; changed_at: number }>(`SELECT h.old_handle, h.changed_at FROM handle_history h
    WHERE h.user_id = ? AND EXISTS (SELECT 1 FROM names n WHERE n.name = h.old_handle) ORDER BY h.changed_at DESC LIMIT 1`, [uid])
  if (!r || Date.now() - Number(r.changed_at) > FORMERLY_MS) return null
  return { name: r.old_handle, until: Number(r.changed_at) + FORMERLY_MS }
}

/** Your primary .wif left your wallet (sold or sent): fall back to another .wif you hold, else you keep your @name as a free name. */
export async function dropName(uid: number, name: string) {
  const n = lc(name)
  const next = await one<{ name: string }>('SELECT name FROM names WHERE owner_id = ? AND name != ? ORDER BY created_at LIMIT 1', [uid, n])
  if (next) return adoptName(uid, next.name)
  await run(`UPDATE users SET extras = json_remove(COALESCE(extras, '{}'), '$.wifName') WHERE id = ?`, [uid])
  // You keep @n as a free name until the new owner makes n.wif their primary (then you're bumped with a grace period).
}
