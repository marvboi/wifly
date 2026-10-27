/** One-time startup maintenance. Runs once at boot, before the server listens; a marker row in maint_runs makes it a no-op afterwards. */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './db'
import { DATABASE_URL } from './config'
import { pendingHandle } from './pending'

export const REMOVE_ASS_ID = 'remove-ass-2026-10-25'

/** Exactly the statements of /workspace/wifly-maint-ass/remove-ass.sql, each tagged with the table it needs. */
const REMOVE_ASS: Array<{ table: string; label: string; sql: string }> = [
  { table: 'name_records', label: 'name_records deleted', sql: `DELETE FROM name_records  WHERE name = 'ass' COLLATE NOCASE` },
  { table: 'name_listings', label: 'name_listings deleted', sql: `DELETE FROM name_listings WHERE name = 'ass' COLLATE NOCASE` },
  { table: 'name_offers', label: 'name_offers cancelled', sql: `UPDATE name_offers SET status = 'cancelled' WHERE name = 'ass' COLLATE NOCASE AND status = 'open'` },
  { table: 'users', label: 'users wifName cleared', sql: `UPDATE users SET extras = json_remove(extras, '$.wifName')
  WHERE lower(json_extract(extras, '$.wifName')) = 'ass'` },
  { table: 'names', label: 'names deleted', sql: `DELETE FROM names WHERE name = 'ass' COLLATE NOCASE AND minted = 0` },
]

/** Directory of the sqlite file, or null when the database isn't a local file (then no backup is possible). */
function dataDir(url: string): string | null {
  if (!url.startsWith('file:')) return null
  try { return dirname(url.startsWith('file://') ? fileURLToPath(url) : resolve(url.slice(5))) } catch { return null }
}

export async function runStartupMaintenance(opts: { url?: string; now?: number; log?: (s: string) => void } = {}) {
  const log = opts.log ?? (s => console.log(s))
  await db.execute(`CREATE TABLE IF NOT EXISTS maint_runs (id TEXT PRIMARY KEY, ran_at INTEGER NOT NULL, summary TEXT NOT NULL DEFAULT '')`)
  const done = await db.execute({ sql: 'SELECT 1 FROM maint_runs WHERE id = ?', args: [REMOVE_ASS_ID] })
  if (done.rows.length) return { ran: false as const, reason: 'already ran' }

  // 1. backup on the volume first; no backup, no delete
  const dir = dataDir(opts.url ?? DATABASE_URL)
  const ts = opts.now ?? Date.now()
  if (!dir) { log(`maint ${REMOVE_ASS_ID}: aborted, database is not a local file so it can't be backed up; nothing deleted`); return { ran: false as const, reason: 'no backup' } }
  const backup = resolve(dir, `wifly.db.bak-remove-ass-${ts}`)
  try { await db.execute({ sql: 'VACUUM INTO ?', args: [backup] }) }
  catch (e) {
    log(`maint ${REMOVE_ASS_ID}: aborted, backup to ${backup} failed (${(e as Error).message}); nothing deleted`)
    await db.execute({ sql: 'INSERT OR IGNORE INTO maint_runs (id, ran_at, summary) VALUES (?, ?, ?)', args: [REMOVE_ASS_ID, ts, 'failed: backup'] }).catch(() => {})
    return { ran: false as const, reason: 'backup failed' }
  }

  // 2. the cleanup + marker in one transaction; statements whose table doesn't exist are skipped
  const tables = new Set((await db.execute(`SELECT name FROM sqlite_master WHERE type = 'table'`)).rows.map(r => String(r.name)))
  // if 'ass' was minted onchain it's a real name now: touch nothing, record the marker
  if (tables.has('names') && (await db.execute(`SELECT 1 FROM names WHERE name = 'ass' COLLATE NOCASE AND minted <> 0`)).rows.length) {
    await db.execute({ sql: 'INSERT INTO maint_runs (id, ran_at, summary) VALUES (?, ?, ?)', args: [REMOVE_ASS_ID, ts, 'skipped: ass is minted'] })
    log(`maint ${REMOVE_ASS_ID}: skipped, ass is minted; nothing changed`)
    return { ran: false as const, reason: 'minted' }
  }
  const steps = REMOVE_ASS.filter(s => tables.has(s.table))
  const skipped = REMOVE_ASS.filter(s => !tables.has(s.table)).map(s => s.table)
  const tx = await db.transaction('write')
  const counts: Record<string, number> = {}
  try {
    for (const s of steps) counts[s.label] = (await tx.execute(s.sql)).rowsAffected
    const summary = [...Object.entries(counts).map(([k, v]) => `${k} ${v}`), ...(skipped.length ? [`skipped (no table): ${skipped.join(', ')}`] : [])].join(', ')
    await tx.execute({ sql: 'INSERT INTO maint_runs (id, ran_at, summary) VALUES (?, ?, ?)', args: [REMOVE_ASS_ID, ts, summary] })
    await tx.commit()
    log(`maint ${REMOVE_ASS_ID}: backup ${backup}; ${summary}`)
    return { ran: true as const, backup, counts, skipped }
  } catch (e) {
    await tx.rollback().catch(() => {})
    await db.execute({ sql: 'INSERT OR IGNORE INTO maint_runs (id, ran_at, summary) VALUES (?, ?, ?)', args: [REMOVE_ASS_ID, ts, 'failed: ' + (e as Error).message] }).catch(() => {})
    throw e
  } finally { tx.close() }
}

export const RETIRE_ASS_ID = 'retire-ass-handle-2026-10-27'
/**
 * Opt-in (RETIRE_ASS_HANDLE=1): the @ass account goes back to "pick your @name" at its next sign-in.
 * Nothing is deleted: posts, follows and the row stay; the old handle gets no redirect. Backup first, runs once.
 */
export async function retireAssHandle(opts: { url?: string; now?: number; log?: (s: string) => void; force?: boolean } = {}) {
  const log = opts.log ?? (s => console.log(s))
  if (!opts.force && process.env.RETIRE_ASS_HANDLE !== '1') return { ran: false as const, reason: 'off' }
  await db.execute(`CREATE TABLE IF NOT EXISTS maint_runs (id TEXT PRIMARY KEY, ran_at INTEGER NOT NULL, summary TEXT NOT NULL DEFAULT '')`)
  if ((await db.execute({ sql: 'SELECT 1 FROM maint_runs WHERE id = ?', args: [RETIRE_ASS_ID] })).rows.length) return { ran: false as const, reason: 'already ran' }
  const dir = dataDir(opts.url ?? DATABASE_URL)
  const ts = opts.now ?? Date.now()
  if (!dir) { log(`maint ${RETIRE_ASS_ID}: aborted, no local database file to back up; nothing changed`); return { ran: false as const, reason: 'no backup' } }
  const backup = resolve(dir, `wifly.db.bak-retire-ass-${ts}`)
  try { await db.execute({ sql: 'VACUUM INTO ?', args: [backup] }) }
  catch (e) { log(`maint ${RETIRE_ASS_ID}: aborted, backup failed (${(e as Error).message}); nothing changed`); return { ran: false as const, reason: 'backup failed' } }
  const r = await db.execute({ sql: `UPDATE users SET handle = ?, extras = json_remove(COALESCE(extras, '{}'), '$.handlePicked') WHERE handle = 'ass' COLLATE NOCASE`, args: [pendingHandle()] })
  await db.execute({ sql: 'INSERT INTO maint_runs (id, ran_at, summary) VALUES (?, ?, ?)', args: [RETIRE_ASS_ID, ts, `users retired ${r.rowsAffected}`] })
  log(`maint ${RETIRE_ASS_ID}: backup ${backup}; users retired ${r.rowsAffected}`)
  return { ran: true as const, backup, retired: r.rowsAffected }
}
