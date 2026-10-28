/**
 * Handle reconcile, decided only by ownerOfName read onchain here (never by anything a client sends).
 * A .wif holder with no picked @name, a reserved handle, or a guest account gets @name. A .wif that left the account's
 * wallets drops its pill and sends its @name back to the name step. A reserved handle with no .wif goes to the name step.
 */
import { resolve } from 'node:path'
import { parseAbi, type Address } from 'viem'
import { all, db, one, run } from './db'
import { rpcCached } from './cache'
import { chainClient } from './chain'
import { DATABASE_URL, namesContract } from './config'
import { walletsOfUser } from './accounts'
import { chainOwnerOf, HANDLE_RE, RESERVED, syncName } from './features'
import { needsHandle, pendingHandle } from './pending'
import { dataDir } from './maint'
import { errLine } from './errline'

type Notify = (to: number, actor: number, kind: string, dropId: string | null, meta?: object) => Promise<void>
let notifyFn: Notify | undefined
export const setReconcileNotify = (n: Notify) => { notifyFn = n }
const BACKUP_ID = 'reconcile-backup'
const NS = parseAbi(['function reverseName(address) view returns (string)'])
const lc = (s: unknown) => String(s ?? '').toLowerCase()
const parse = (s: string | null | undefined) => { try { return JSON.parse(s || '{}') } catch { return {} } }
/** Brand accounts may hold a reserved word on purpose; every other reserved handle is reconciled. */
const BRAND = new Set(['wifly', 'wif', 'worldisflat', 'marv', 'support', 'help', 'official', 'team', 'staff', 'admin', 'security'])
export const isReservedHandle = (h: string) => !h.startsWith('~') && RESERVED.has(lc(h)) && !BRAND.has(lc(h))

type Row = { id: number; handle: string; name: string | null; extras: string | null; onboarded: number }

/** Names this account's wallets hold right now: each wallet's onchain primary first, then minted mirror rows. Backfills the mirror. */
export async function ownedNames(uid: number): Promise<string[]> {
  const N = namesContract()
  const wallets = await walletsOfUser(uid)
  const tries: string[] = []
  if (N) for (const w of wallets) {
    const nm = await rpcCached(`ns:rev:${w}`, 10_000, () => chainClient().readContract({ address: N, abi: NS, functionName: 'reverseName', args: [w as Address] })).catch(() => '')
    const label = lc(nm).replace(/\.wif$/, '')
    if (label) tries.push(label)
  }
  if (!N) return []
  for (const r of await all<{ name: string }>('SELECT name FROM names WHERE owner_id = ? AND minted = 1 ORDER BY created_at ASC LIMIT 8', [uid])) tries.push(lc(r.name))
  const out: string[] = []
  for (const t of [...new Set(tries)]) {
    if (!HANDLE_RE.test(t) || RESERVED.has(t)) continue
    const owner = await chainOwnerOf(t)
    if (!owner || !wallets.has(owner)) continue
    await syncName(t, { onlyKnown: true }).catch(() => null)
    out.push(t)
  }
  return out
}

async function backupOnce(opts: { url?: string; now?: number }) {
  await db.execute(`CREATE TABLE IF NOT EXISTS maint_runs (id TEXT PRIMARY KEY, ran_at INTEGER NOT NULL, summary TEXT NOT NULL DEFAULT '')`)
  if (await one('SELECT 1 FROM maint_runs WHERE id = ?', [BACKUP_ID])) return true
  const dir = dataDir(opts.url ?? DATABASE_URL)
  const ts = opts.now ?? Date.now()
  let summary = 'no local file'
  if (dir) {
    const file = resolve(dir, `wifly.db.bak-reconcile-${ts}`)
    try { await db.execute({ sql: 'VACUUM INTO ?', args: [file] }); summary = `backup ${file}` } catch { return false }
  }
  await run('INSERT OR IGNORE INTO maint_runs (id, ran_at, summary) VALUES (?, ?, ?)', [BACKUP_ID, ts, summary])
  return true
}

export type ReconcileResult = { uid: number; action: 'none' | 'renamed' | 'name-step'; handle?: string; bumped?: number | null }

/** Reconcile one account. Safe to call any time (sign-in, wallet link, sweep, boot). */
export async function reconcileUser(uid: number, opts: { url?: string; now?: number; log?: (s: string) => void } = {}): Promise<ReconcileResult> {
  const u = await one<Row>('SELECT id, handle, name, extras, onboarded FROM users WHERE id = ? AND deleted_at IS NULL', [uid])
  if (!u) return { uid, action: 'none' }
  const log = opts.log ?? (s => console.log(s))
  const lost = await dropLostName(uid, u, opts, log)
  if (lost) { u.handle = lost.handle; u.extras = lost.extras }
  const ex = parse(u.extras)
  const reserved = isReservedHandle(u.handle)
  const eligible = reserved || needsHandle(u) || !!ex.guest && !ex.handlePicked
  if (!eligible) {
    // a .wif that arrived some other way (bought or sent) to an account without one: it gets the pill and the @name
    if (!ex.wifName) { const [n] = await ownedNames(uid); if (n) return useOwnedName(uid, n, opts) }
    return { uid, action: lost ? 'name-step' : 'none' }
  }
  const names = await ownedNames(uid)
  for (const n of names) {
    if (n === lc(u.handle)) return { uid, action: 'none' }
    return takeName(uid, u, n, opts, log)
  }
  if (reserved) {
    if (!(await backupOnce(opts))) return { uid, action: 'none' }
    await run(`UPDATE users SET handle = ?, name = CASE WHEN lower(name) = lower(?) THEN '' ELSE name END, extras = json_remove(COALESCE(extras, '{}'), '$.handlePicked') WHERE id = ?`, [pendingHandle(), u.handle, uid])
    await run('DELETE FROM handle_history WHERE old_handle = ?', [lc(u.handle)])
    log(`[reconcile] u${uid} had a reserved handle and no .wif: back to the name step`)
    return { uid, action: 'name-step' }
  }
  return { uid, action: lost ? 'name-step' : 'none' }
}

/** Give the account @n and the n.wif pill (the caller has read ownerOfName onchain). A free holder of @n goes back to the name step. */
async function takeName(uid: number, u: Row, n: string, opts: { url?: string; now?: number }, log: (s: string) => void): Promise<ReconcileResult> {
  const holder = await one<{ id: number }>('SELECT id FROM users WHERE handle = ? COLLATE NOCASE AND id <> ?', [n, uid])
  if (!(await backupOnce(opts))) { log('[reconcile] skipped, backup failed'); return { uid, action: 'none' } }
  const t = opts.now ?? Date.now()
  const tx = await db.transaction('write')
  try {
    if (holder) await tx.execute({ sql: `UPDATE users SET handle = ?, extras = json_set(json_remove(COALESCE(extras, '{}'), '$.handlePicked'), '$.handleNotice', ?) WHERE id = ?`, args: [pendingHandle(), n, Number(holder.id)] })
    await tx.execute({ sql: `UPDATE users SET handle = ?, name = CASE WHEN name IS NULL OR name = '' OR lower(name) = lower(?) THEN ? ELSE name END,
      extras = json_set(json_remove(COALESCE(extras, '{}'), '$.guest', '$.handleNotice'), '$.wifName', ?, '$.handlePicked', 1) WHERE id = ?`, args: [n, u.handle, n, n, uid] })
    await tx.execute({ sql: `INSERT INTO names (name, owner_id, minted, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(name) DO UPDATE SET owner_id = excluded.owner_id, minted = 1`, args: [n, uid, t] })
    await tx.execute({ sql: 'DELETE FROM handle_history WHERE old_handle = ? OR old_handle = ?', args: [n, lc(u.handle)] })
    await tx.execute({ sql: 'UPDATE handle_bumps SET settled_at = ? WHERE handle = ? AND settled_at IS NULL', args: [t, n] }).catch(() => null)
    await tx.commit()
  } catch (e) { await tx.rollback().catch(() => {}); throw e } finally { tx.close() }
  if (holder && notifyFn) await notifyFn(Number(holder.id), uid, 'handle_bump', null, { handle: n, renameBy: t }).catch(() => {})
  log(`[reconcile] u${uid} -> @${n}${holder ? ` (u${holder.id} back to the name step)` : ''}`)
  return { uid, action: 'renamed', handle: n, bumped: holder ? Number(holder.id) : null }
}

/** "use my .wif": the wallet proved itself and ownerOfName (read here) says it holds n. Pill and @name both move to n. */
export async function useOwnedName(uid: number, n: string, opts: { url?: string; now?: number; log?: (s: string) => void } = {}): Promise<ReconcileResult> {
  const u = await one<Row>('SELECT id, handle, name, extras, onboarded FROM users WHERE id = ? AND deleted_at IS NULL', [uid])
  if (!u) return { uid, action: 'none' }
  const log = opts.log ?? (s => console.log(s))
  if (lc(u.handle) === n) {
    await run(`UPDATE users SET extras = json_set(COALESCE(extras, '{}'), '$.wifName', ?, '$.handlePicked', 1) WHERE id = ?`, [n, uid])
    await run(`INSERT INTO names (name, owner_id, minted, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(name) DO UPDATE SET owner_id = excluded.owner_id, minted = 1`, [n, uid, Date.now()])
    return { uid, action: 'none', handle: n }
  }
  return takeName(uid, u, n, opts, log)
}

/** The account's .wif (its main name, or the name its @handle matches) left its wallets onchain: drop the pill, @name back to the name step. */
async function dropLostName(uid: number, u: Row, opts: { url?: string; now?: number }, log: (s: string) => void): Promise<{ handle: string; extras: string } | null> {
  if (!namesContract()) return null
  const ex = parse(u.extras)
  const cands = new Set<string>()
  if (ex.wifName) cands.add(lc(ex.wifName))
  for (const r of await all<{ name: string }>('SELECT name FROM names WHERE owner_id = ? AND minted = 1 LIMIT 8', [uid])) cands.add(lc(r.name))
  if (!cands.size) return null
  const wallets = await walletsOfUser(uid)
  let changed = false
  for (const n of cands) {
    const owner = await chainOwnerOf(n)
    if (owner === undefined || (owner && wallets.has(owner))) continue // unreadable chain: change nothing
    if (!(await backupOnce(opts))) return null
    await syncName(n, { onlyKnown: true }).catch(() => null) // the new holder's account, if they have one, gets the mirror row
    await run('DELETE FROM names WHERE name = ? AND owner_id = ?', [n, uid])
    if (lc(ex.wifName) === n) await run(`UPDATE users SET extras = json_remove(COALESCE(extras, '{}'), '$.wifName') WHERE id = ?`, [uid])
    if (lc(u.handle) === n) {
      await run(`UPDATE users SET handle = ?, extras = json_set(json_remove(COALESCE(extras, '{}'), '$.handlePicked'), '$.handleNotice', ?) WHERE id = ? AND lower(handle) = ?`, [pendingHandle(), n, uid, n])
      await run('DELETE FROM handle_history WHERE old_handle = ?', [n])
    }
    log(`[reconcile] u${uid} no longer holds ${n}.wif`)
    changed = true
  }
  if (!changed) return null
  const r = await one<{ handle: string; extras: string }>('SELECT handle, extras FROM users WHERE id = ?', [uid])
  return r ? { handle: r.handle, extras: r.extras } : null
}

/** Every account that could need it: reserved handles, no picked @name, guests, or minted names that aren't the @name yet. */
export async function reconcileAll(opts: { url?: string; now?: number; log?: (s: string) => void; limit?: number; light?: boolean } = {}) {
  const reserved = [...RESERVED]
  // the sweep walks every .wif holder in turn (a cursor over ids), so each linked or used .wif is re-read onchain every few minutes at most
  const cur = opts.light ? Number((await one<{ v: string }>("SELECT v FROM kv WHERE k = 'reconcile:cursor'"))?.v ?? 0) : 0
  const limit = opts.limit ?? 500
  const rows = await all<{ id: number }>(`SELECT id FROM users WHERE deleted_at IS NULL AND id > ? AND (
      (? = 0 AND (handle LIKE '~%' OR json_extract(extras, '$.guest') = 1 OR (handle GLOB 'wif_*' AND json_extract(extras, '$.handlePicked') IS NULL)))
      OR lower(handle) IN (${reserved.map(() => '?').join(',')})
      OR id IN (SELECT owner_id FROM names WHERE minted = 1)
      OR json_extract(extras, '$.wifName') IS NOT NULL
    ) ORDER BY id LIMIT ?`, [cur, opts.light ? 1 : 0, ...reserved, limit])
  if (opts.light) await run("INSERT INTO kv (k, v) VALUES ('reconcile:cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [String(rows.length < limit ? 0 : Number(rows[rows.length - 1].id))])
  const out: ReconcileResult[] = []
  for (const r of rows) {
    try { const x = await reconcileUser(Number(r.id), opts); if (x.action !== 'none') out.push(x) }
    catch (e) { (opts.log ?? console.warn)(`[reconcile] u${r.id} failed: ${errLine(e, 80)}`) }
  }
  return out
}
