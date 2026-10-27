/** Client IP resolution behind Caddy/Railway, and rate-limit keys that can't be evicted while their window is open. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'

const dir = mkdtempSync(join(tmpdir(), 'wifly-ip-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
delete process.env.REDIS_URL
process.env.RATE_MAX_KEYS = '100'

const { clientIp, isInternal } = await import('../src/abuse')
const { store, fnv1a, overflowBucket, OVERFLOW_BUCKETS } = await import('../src/cache')

const app = new Hono().get('/ip', c => c.text(clientIp(c)))
const ipOf = async (peer: string | null, headers: Record<string, string> = {}) =>
  (await app.request('/ip', { headers }, peer === null ? undefined : { incoming: { socket: { remoteAddress: peer } } })).text()

test('ip: via Caddy on the private network, X-Real-IP is the visitor', async () => {
  assert.equal(await ipOf('fd12:3456::7', { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' }), '203.0.113.9')
  assert.equal(await ipOf('::ffff:10.1.2.3', { 'x-real-ip': '198.51.100.4' }), '198.51.100.4')
  assert.equal(await ipOf('100.64.0.12', { 'x-real-ip': '198.51.100.5' }), '198.51.100.5') // Railway edge straight to the api
})

test('ip: a public peer cannot spoof X-Forwarded-For / X-Real-IP / CF-Connecting-IP', async () => {
  const spoof = { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8', 'cf-connecting-ip': '9.9.9.9' }
  assert.equal(await ipOf('203.0.113.50', spoof), '203.0.113.50')
  assert.equal(await ipOf('::ffff:203.0.113.51', spoof), '203.0.113.51')
})

test('ip: CF-Connecting-IP is never used, junk headers fall through', async () => {
  assert.equal(await ipOf('10.0.0.2', { 'cf-connecting-ip': '9.9.9.9' }), '10.0.0.2')
  assert.equal(await ipOf('10.0.0.2', { 'x-real-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.7, 10.0.0.9' }), '198.51.100.7')
  assert.equal(await ipOf(null), 'local')
})

test('ip: internal ranges', () => {
  for (const a of ['127.0.0.1', '10.9.8.7', '172.16.0.1', '172.31.255.1', '192.168.1.1', '100.64.0.1', '100.127.255.254', '::1', 'fd12::1', 'fc00::1', 'fe80::1'])
    assert.ok(isInternal(a), a)
  for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '100.63.255.255', '2001:db8::1', '203.0.113.1'])
    assert.ok(!isInternal(a), a)
})

test('rate keys: flooding fresh keys never resets an open window; new keys fail closed into hashed overflow buckets', async () => {
  store.reset()
  const W = 60_000
  for (let i = 0; i < 3; i++) await store.hit('up:victim', W)
  for (let i = 0; i < 99; i++) await store.hit(`up:attacker${i}`, W) // table now full (100) of open windows
  assert.equal(store.rateKeys!(), 100)
  // a big flood of fresh keys: none admitted, none evicted
  for (let i = 0; i < 5000; i++) await store.hit(`up:flood${i}`, W)
  assert.equal(store.rateKeys!(), 100)
  assert.equal(await store.hit('up:victim', W), 4, 'victim count survived the flood')
  assert.equal(await store.hit('up:attacker5', W), 2, 'existing keys still count normally')
  // the flood ran into limits: ~5000/256 = ~20 hits per bucket, so a flood key re-hitting is well past a 10/window rule
  assert.ok((await store.hit('up:flood0', W)) > 10)
  // the same key always lands in the same bucket, so retrying under the overflow keeps counting up
  const a = await store.hit('up:retry', W), b = await store.hit('up:retry', W)
  assert.equal(b, a + 1)
})

test('rate keys: distinct newcomers mostly land in different overflow buckets, so not all of them get 429', async () => {
  store.reset()
  const W = 60_000, LIMIT = 3 // e.g. signup:id is 3 per hour
  for (let i = 0; i < 100; i++) await store.hit(`fill:${i}`, W) // full, of another rule
  const keys = Array.from({ length: 200 }, (_, i) => `signup:id:user${i}@example.com`)
  const buckets = new Set(keys.map(k => overflowBucket(k, W)))
  assert.ok(buckets.size > 140, `200 keys spread over ${buckets.size} of ${OVERFLOW_BUCKETS} buckets`) // ~140-150 expected
  const counts = []
  for (const k of keys) counts.push(await store.hit(k, W))
  const allowed = counts.filter(c => c <= LIMIT).length
  assert.ok(allowed >= 190, `${allowed}/200 newcomers under the limit`) // with one shared bucket only 3 would be
  assert.equal(store.rateKeys!(), 100)
  // buckets are per rule and window: a flood on one rule doesn't spend another rule's overflow
  for (let i = 0; i < 3000; i++) await store.hit(`drop:flood${i}`, W)
  assert.equal(await store.hit('up:newcomer', W), 1)
  assert.equal(await store.hit('signup:id:user0@example.com', 3_600_000), 1, 'other window length, own bucket')
})

test('rate keys: FNV-1a is the standard 32-bit hash and spreads evenly', () => {
  assert.equal(fnv1a(''), 0x811c9dc5)
  assert.equal(fnv1a('a'), 0xe40c292c)
  assert.equal(fnv1a('foobar'), 0xbf9cf968)
  const per = new Array(OVERFLOW_BUCKETS).fill(0)
  for (let i = 0; i < 25_600; i++) per[fnv1a(`up:u_${i}`) % OVERFLOW_BUCKETS]++
  assert.ok(Math.max(...per) < 160 && Math.min(...per) > 50, `bucket loads ${Math.min(...per)}..${Math.max(...per)} (mean 100)`)
})

test('rate keys: once windows close, the table frees up and new keys get their own count again', async () => {
  store.reset()
  for (let i = 0; i < 100; i++) await store.hit(`short:${i}`, 30)
  assert.equal(await store.hit('late', 30), 1) // overflow bucket (first hit)
  assert.ok(await store.hit('late', 30) >= 2, 'the same key keeps its overflow bucket')
  await new Promise(r => setTimeout(r, 1100)) // windows over, and past the 1 s full-sweep throttle
  assert.equal(await store.hit('fresh', 60_000), 1)
  assert.equal(await store.hit('fresh', 60_000), 2)
  assert.ok(store.rateKeys!() < 100)
})

test('rate keys: a hammered key keeps a bounded log (RATE_MAX_HITS) and stays over every limit', async () => {
  store.reset()
  let last = 0
  for (let i = 0; i < 2000; i++) { const n = await store.hit('t:hammer', 60_000); assert.ok(n >= last); last = n }
  assert.ok(last > 512, `count ${last} stays above the cap`)
})

test('rate limits: an env limit above the hit-log cap is clamped, so it still trips (no >512 bypass)', async () => {
  const { rateLimit, effectiveLimit } = await import('../src/util')
  const { RATE_MAX_HITS } = await import('../src/cache')
  assert.equal(effectiveLimit(1000), RATE_MAX_HITS)
  assert.equal(effectiveLimit(5), 5)
  assert.equal(effectiveLimit(Number('oops')), RATE_MAX_HITS, 'a non-number fails closed to the cap')
  store.reset()
  let blocked = 0
  for (let i = 0; i < RATE_MAX_HITS + 50; i++) { try { await rateLimit('t:bigenv', 1000, 60_000) } catch { blocked++ } }
  assert.equal(blocked, 50, 'hits past the cap are refused even though the configured limit is 1000')
})
