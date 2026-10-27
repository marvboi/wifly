/** Bounded in-memory cache: LRU order, expiry sweeps, entry/byte caps, and flat memory under unique-key churn. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'

const dir = mkdtempSync(join(tmpdir(), 'wifly-lru-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
delete process.env.REDIS_URL
process.env.RATE_MAX_KEYS = '20000' // below the 200k default so the 80k-key pass below runs into the cap
process.env.CACHE_MAX_ENTRIES = '5000'

const { Lru } = await import('../src/lru')
const { store, cached, invalidate, CACHE_MAX_ENTRIES } = await import('../src/cache')

v8.setFlagsFromString('--expose-gc')
const gc: () => void = (globalThis as { gc?: () => void }).gc ?? vm.runInNewContext('gc')
const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed }

test('lru: get moves to the end, set evicts the oldest past max', () => {
  const l = new Lru<string, number>({ max: 3 })
  l.set('a', 1).set('b', 2).set('c', 3)
  assert.equal(l.get('a'), 1) // a is now most recent
  l.set('d', 4)
  assert.equal(l.size, 3)
  assert.equal(l.get('b'), undefined) // b was oldest
  assert.deepEqual([...l.keys()], ['c', 'a', 'd'])
})

test('lru: expired entries are swept on set and by sweep(), not only on read', async () => {
  const l = new Lru<string, number>({ max: 100 })
  for (let i = 0; i < 10; i++) l.set(`old${i}`, i, 5)
  await new Promise(r => setTimeout(r, 15))
  l.set('new', 1) // sweeps a few of the oldest
  assert.ok(l.size < 11, `amortized sweep removed some (size ${l.size})`)
  l.sweep()
  assert.equal(l.size, 1)
})

test('lru: byte cap evicts oldest until under it', () => {
  const l = new Lru<string, string>({ max: 1000, maxBytes: 1000, size: v => v.length })
  for (let i = 0; i < 50; i++) l.set(`k${i}`, 'x'.repeat(100))
  assert.ok(l.approxBytes <= 1000)
  assert.equal(l.size, 10)
  assert.equal(l.get('k49')?.length, 100)
})

test('store: 50,000 unique-key write/read cycles stay under the cap with flat heap', async () => {
  assert.equal(store.kind, 'memory')
  assert.equal(CACHE_MAX_ENTRIES, 5000)
  // warm up to the cap first so the baseline already holds a full cache
  for (let i = 0; i < 6000; i++) await store.set(`warm:${i}`, String(i).padStart(400, '0'), 60_000)
  const before = heap()
  for (let i = 0; i < 50_000; i++) {
    await store.set(`k:${i}:${Math.random()}`, String(i).padStart(400, '0'), 60_000)
    await store.get(`k:${i - 1}`)
    if (i % 1000 === 0) assert.ok(store.size!() <= CACHE_MAX_ENTRIES)
  }
  assert.ok(store.size!() <= CACHE_MAX_ENTRIES, `size ${store.size!()}`)
  const grown = heap() - before
  assert.ok(grown < 8 * 1024 * 1024, `heap grew ${(grown / 1048576).toFixed(1)} MB`)
})

test('cached(): fresh generations on every write do not grow the store past the cap', async () => {
  const before = heap()
  for (let i = 0; i < 50_000; i++) {
    if (i % 5 === 0) await invalidate('feed') // a write elsewhere: every old key is orphaned
    await cached(['feed'], `page:${i % 50}`, 10_000, async () => ({ items: 'x'.repeat(300), i }))
  }
  assert.ok(store.size!() <= CACHE_MAX_ENTRIES, `size ${store.size!()}`)
  const grown = heap() - before
  assert.ok(grown < 8 * 1024 * 1024, `heap grew ${(grown / 1048576).toFixed(1)} MB`)
})

test('rate limiter: unique keys stay bounded and windows still count', async () => {
  assert.equal(await store.hit('rl-same', 1000), 1)
  assert.equal(await store.hit('rl-same', 1000), 2)
  for (let i = 0; i < 30_000; i++) await store.hit(`rl:${i}`, 60_000)
  // RATE_MAX_KEYS pinned to 20,000 above (default 200,000); the hit map is internal, so check heap stays flat once full
  const before = heap()
  for (let i = 30_000; i < 80_000; i++) await store.hit(`rl:${i}`, 60_000)
  const grown = heap() - before
  assert.ok(grown < 8 * 1024 * 1024, `heap grew ${(grown / 1048576).toFixed(1)} MB`)
})
