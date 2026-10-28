/** One-time startup maintenance (remove-ass): backup first, exact SQL, marker, never twice. `npm test` */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wifly-maint-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'

const { migrate, db, run, one, all } = await import('../src/db')
const { runStartupMaintenance, REMOVE_ASS_ID } = await import('../src/maint')
const quiet = { log: () => {} }

before(async () => { await migrate() })
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

async function user(handle: string, extras: object = {}) {
  await run(`INSERT INTO users (handle, name, extras, onboarded, created_at) VALUES (?, ?, ?, 1, 1)`, [handle, handle, JSON.stringify(extras)])
  return Number((await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', [handle]))!.id)
}

test('deletes only the unminted ass name, keeps the @ass account and other names, then never runs again', async () => {
  const ass = await user('ass', { wifName: 'ass', bio: 'keep me' })
  const other = await user('bassist', { wifName: 'bass' })
  await run(`INSERT INTO names (name, owner_id, minted, created_at) VALUES ('ass', ?, 0, 1), ('bass', ?, 0, 1), ('asset', ?, 1, 1)`, [ass, other, other])
  await run(`INSERT INTO name_records (name, address, updated_at) VALUES ('ass', '0x1', 1), ('bass', '0x2', 1)`)
  await run(`INSERT INTO name_listings (name, seller_id, price, created_at) VALUES ('ass', ?, 10, 1), ('bass', ?, 10, 1)`, [ass, other])
  await run(`INSERT INTO name_offers (name, buyer_id, price, status, expires_at, created_at) VALUES ('ass', ?, 5, 'open', 9, 1), ('ass', ?, 5, 'accepted', 9, 1), ('bass', ?, 5, 'open', 9, 1)`, [other, other, ass])

  const lines: string[] = []
  const r = await runStartupMaintenance({ now: 111, log: s => lines.push(s) })
  assert.equal(r.ran, true)
  assert.ok(existsSync(join(dir, 'wifly.db.bak-remove-ass-111')), 'backup written next to the database first')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /names deleted 1/)

  assert.deepEqual((await all<{ name: string }>('SELECT name FROM names ORDER BY name')).map(x => x.name), ['asset', 'bass'])
  assert.deepEqual((await all<{ name: string }>('SELECT name FROM name_records')).map(x => x.name), ['bass'])
  assert.deepEqual((await all<{ name: string }>('SELECT name FROM name_listings')).map(x => x.name), ['bass'])
  assert.deepEqual((await all<{ name: string; status: string }>('SELECT name, status FROM name_offers ORDER BY id')).map(x => `${x.name}:${x.status}`), ['ass:cancelled', 'ass:accepted', 'bass:open'])
  const u = await one<{ handle: string; extras: string }>('SELECT handle, extras FROM users WHERE id = ?', [ass])
  assert.equal(u!.handle, 'ass', 'the @ass account stays')
  assert.deepEqual(JSON.parse(u!.extras), { bio: 'keep me' })
  assert.equal(JSON.parse((await one<{ extras: string }>('SELECT extras FROM users WHERE id = ?', [other]))!.extras).wifName, 'bass')
  assert.ok(await one('SELECT 1 FROM maint_runs WHERE id = ?', [REMOVE_ASS_ID]))

  // second boot: marker present, nothing happens (no new backup, a fresh unminted ass survives)
  await run(`INSERT INTO names (name, owner_id, minted, created_at) VALUES ('ass', ?, 0, 2)`, [ass])
  const again = await runStartupMaintenance({ now: 222, ...quiet })
  assert.equal(again.ran, false)
  assert.ok(!existsSync(join(dir, 'wifly.db.bak-remove-ass-222')))
  assert.ok(await one(`SELECT 1 FROM names WHERE name = 'ass'`))
  await run(`DELETE FROM names WHERE name = 'ass'`)
})

test('a minted ass name: nothing is touched, the marker says skipped', async () => {
  await run('DELETE FROM maint_runs')
  const owner = Number((await one<{ id: number }>(`SELECT id FROM users WHERE handle = 'ass'`))!.id)
  const fan = Number((await one<{ id: number }>(`SELECT id FROM users WHERE handle = 'bassist'`))!.id)
  await run(`INSERT INTO names (name, owner_id, minted, created_at) VALUES ('ASS', ?, 1, 3)`, [owner])
  await run(`INSERT INTO name_records (name, address, updated_at) VALUES ('ass', '0x3', 3)`)
  await run(`INSERT INTO name_listings (name, seller_id, price, created_at) VALUES ('ass', ?, 20, 3)`, [owner])
  await run(`INSERT INTO name_offers (name, buyer_id, price, status, expires_at, created_at) VALUES ('ass', ?, 7, 'open', 9, 3)`, [fan])
  await run(`UPDATE users SET extras = json_set(extras, '$.wifName', 'ass') WHERE id = ?`, [owner])
  const before = async () => ({
    names: await all('SELECT * FROM names ORDER BY name'), records: await all('SELECT * FROM name_records ORDER BY name'),
    listings: await all('SELECT * FROM name_listings ORDER BY name'), offers: await all('SELECT * FROM name_offers ORDER BY id'),
    users: await all('SELECT id, handle, extras FROM users ORDER BY id'),
  })
  const snap = JSON.stringify(await before())
  const r = await runStartupMaintenance({ now: 333, ...quiet })
  assert.deepEqual(r, { ran: false, reason: 'minted' })
  assert.equal(JSON.stringify(await before()), snap, 'records, listings, offers, names and wifName all intact')
  assert.equal(JSON.parse((await one<{ extras: string }>('SELECT extras FROM users WHERE id = ?', [owner]))!.extras).wifName, 'ass')
  assert.equal((await one<{ summary: string }>('SELECT summary FROM maint_runs WHERE id = ?', [REMOVE_ASS_ID]))!.summary, 'skipped: ass is minted')
  // marker recorded: a later boot does nothing either
  assert.deepEqual(await runStartupMaintenance({ now: 334, ...quiet }), { ran: false, reason: 'already ran' })
  // tidy up for the next tests
  await run(`DELETE FROM name_records WHERE name = 'ass'`); await run(`DELETE FROM name_listings WHERE name = 'ass'`)
})

test('no backup, no delete', async () => {
  await run('DELETE FROM maint_runs')
  await run(`DELETE FROM names WHERE name = 'ass'`)
  const owner = Number((await one<{ id: number }>(`SELECT id FROM users WHERE handle = 'ass'`))!.id)
  await run(`INSERT INTO names (name, owner_id, minted, created_at) VALUES ('ass', ?, 0, 4)`, [owner])
  const bad = await runStartupMaintenance({ url: `file:${join(dir, 'missing-dir', 'wifly.db')}`, now: 444, ...quiet })
  assert.equal(bad.ran, false)
  assert.ok(await one(`SELECT 1 FROM names WHERE name = 'ass'`), 'still there')
  assert.equal((await one<{ summary: string }>('SELECT summary FROM maint_runs WHERE id = ?', [REMOVE_ASS_ID]))?.summary, 'failed: backup', 'failed marker so it does not back up every boot')
  const again = await runStartupMaintenance({ url: `file:${join(dir, 'missing-dir', 'wifly.db')}`, now: 445, ...quiet })
  assert.equal(again.ran, false)
  await run('DELETE FROM maint_runs')
  const remote = await runStartupMaintenance({ url: 'libsql://example.turso.io', ...quiet })
  assert.equal(remote.ran, false)
  assert.ok(readdirSync(dir).every(f => !f.includes('444')))
})

test('statements for missing tables are skipped, not fatal', async () => {
  await run('DELETE FROM maint_runs')
  await run('DROP TABLE name_listings')
  const r = await runStartupMaintenance({ now: 555, ...quiet })
  assert.equal(r.ran, true)
  assert.deepEqual(r.ran && r.skipped, ['name_listings'])
  assert.equal(await one(`SELECT 1 FROM names WHERE name = 'ass'`), undefined)
})

test('a failed delete leaves a failed marker and nothing deleted', async () => {
  await run('DELETE FROM maint_runs')
  await run(`DELETE FROM names WHERE name = 'ass'`)
  const owner = Number((await one<{ id: number }>(`SELECT id FROM users WHERE handle = 'ass'`))!.id)
  await run(`INSERT INTO names (name, owner_id, minted, created_at) VALUES ('ass', ?, 0, 6)`, [owner])
  await run(`CREATE TRIGGER boom BEFORE DELETE ON names BEGIN SELECT RAISE(ABORT, 'boom'); END`)
  await assert.rejects(runStartupMaintenance({ now: 666, ...quiet }), /boom/)
  await run('DROP TRIGGER boom')
  assert.ok(await one(`SELECT 1 FROM names WHERE name = 'ass'`), 'rolled back, still there')
  const m = await one<{ summary: string }>('SELECT summary FROM maint_runs WHERE id = ?', [REMOVE_ASS_ID])
  assert.match(String(m?.summary), /^failed: .*boom/)
  const again = await runStartupMaintenance({ now: 667, ...quiet })
  assert.equal(again.ran, false)
  assert.ok(readdirSync(dir).every(f => !f.includes('667')), 'no second backup')
})
