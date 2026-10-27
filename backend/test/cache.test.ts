/** Read cache: hits, stale-while-revalidate, write invalidation by table, ETag 304s. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wifly-cache-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
delete process.env.REDIS_URL

const { cached, nsForSql, cacheStats } = await import('../src/cache')
const { migrate, run } = await import('../src/db')
const { app } = await import('../src/app')
await migrate()

test('cache: in-memory when REDIS_URL is unset; second read is a hit', async () => {
  assert.equal(cacheStats().kind, 'memory')
  let n = 0
  const f = async () => ({ n: ++n })
  assert.deepEqual(await cached(['feed'], 't1', 1000, f), { n: 1 })
  assert.deepEqual(await cached(['feed'], 't1', 1000, f), { n: 1 })
  assert.equal(n, 1)
})

test('cache: stale value is served at once and refreshed behind', async () => {
  let n = 0
  const f = async () => { n++; await new Promise(r => setTimeout(r, 30)); return n }
  assert.equal(await cached(['users'], 't2', 20, f), 1)
  await new Promise(r => setTimeout(r, 40))
  const t = Date.now()
  assert.equal(await cached(['users'], 't2', 20, f), 1, 'stale served')
  assert.ok(Date.now() - t < 25, 'without waiting on the refresh')
  await new Promise(r => setTimeout(r, 50))
  assert.equal(await cached(['users'], 't2', 1000, f), 2, 'refreshed behind')
})

test('cache: concurrent misses share one computation', async () => {
  let n = 0
  const f = async () => { n++; await new Promise(r => setTimeout(r, 20)); return n }
  const r = await Promise.all([1, 2, 3, 4].map(() => cached(['creators'], 't3', 1000, f)))
  assert.deepEqual(r, [1, 1, 1, 1])
})

test('cache: writes retire what they touch, by table', async () => {
  assert.deepEqual(nsForSql('INSERT INTO drops (id) VALUES (?)'), ['feed', 'drop', 'users', 'creators'])
  assert.deepEqual(nsForSql('INSERT OR IGNORE INTO follows VALUES (?, ?)'), ['feed', 'drop', 'users', 'creators'])
  assert.ok(nsForSql('UPDATE names SET owner_id = ?').includes('names'))
  assert.deepEqual(nsForSql('DELETE FROM sessions WHERE id = ?'), [])
  assert.deepEqual(nsForSql('SELECT * FROM drops'), [])
  let n = 0
  const f = async () => ++n
  assert.equal(await cached(['feed'], 't4', 60_000, f), 1)
  await run(`INSERT INTO tags (tag, drop_id, created_at) VALUES ('x', 'y', 1)`).catch(() => run('UPDATE drops SET deleted = deleted WHERE 0'))
  assert.equal(await cached(['feed'], 't4', 60_000, f), 2, 'a write retired the feed entry')
})

test('etag: same response twice gives a 304 with If-None-Match', async () => {
  const h = { host: 'localhost:5173', 'x-wifly': '1' }
  const a = await app.request('/api/config', { headers: h })
  const tag = a.headers.get('etag')
  assert.ok(tag && tag.startsWith('W/"'))
  assert.match(a.headers.get('cache-control') ?? '', /private/)
  const b = await app.request('/api/config', { headers: { ...h, 'if-none-match': tag! } })
  assert.equal(b.status, 304)
  assert.equal(await b.text(), '')
})
