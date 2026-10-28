/** Old tip notifications (filed by the app before verify-first, so no dkey) had a client-claimed amount. The boot migration
 *  hides that amount and keeps every row; verified tips (dkey set) and other kinds are untouched; running it again changes nothing. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wifly-legacy-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
delete process.env.REDIS_URL
const { db, migrate } = await import('../src/db')

test('legacy tip notifications: amount hidden, rows kept, idempotent', async () => {
  await migrate()
  const ins = (kind: string, meta: object | string, dkey: string | null) => db.execute({
    sql: 'INSERT INTO notifications (user_id, actor_id, kind, drop_id, meta, created_at, dkey) VALUES (1, 2, ?, NULL, ?, 1, ?)',
    args: [kind, typeof meta === 'string' ? meta : JSON.stringify(meta), dkey] })
  await ins('tip', { amount: 999999, gross: 1000000 }, null) // faked by a client
  await ins('tip', { amount: 7.84, gross: 8, dm: true }, null) // old chat tip
  await ins('tip', { chain: true, from: '0xabc', amount: 5 }, null)
  await ins('tip', {}, null) // already no amount
  await ins('tip', 'not json', null) // broken meta is left alone
  await ins('tip', { amount: 9.8, gross: 10 }, 'tip:0x' + '1'.repeat(64)) // verified, keeps its number
  await ins('like', { amount: 3 }, null) // not a tip
  const before = Number((await db.execute('SELECT COUNT(*) n FROM notifications')).rows[0].n)
  await migrate(); await migrate()
  const rows = (await db.execute('SELECT kind, meta, dkey FROM notifications ORDER BY id')).rows.map(r => ({ kind: r.kind, meta: String(r.meta), dkey: r.dkey }))
  assert.equal(rows.length, before, 'no row deleted')
  assert.equal(rows.length, 7)
  assert.deepEqual(JSON.parse(rows[0].meta), {})
  assert.deepEqual(JSON.parse(rows[1].meta), { dm: true })
  assert.deepEqual(JSON.parse(rows[2].meta), { chain: true, from: '0xabc' })
  assert.deepEqual(JSON.parse(rows[3].meta), {})
  assert.equal(rows[4].meta, 'not json')
  assert.deepEqual(JSON.parse(rows[5].meta), { amount: 9.8, gross: 10 })
  assert.deepEqual(JSON.parse(rows[6].meta), { amount: 3 })
  for (const r of rows.slice(0, 5)) assert.ok(!/amount|gross/.test(r.meta), 'no number left on an old tip')
})
