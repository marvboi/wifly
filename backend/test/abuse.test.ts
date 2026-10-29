/** Bot friction: Turnstile (skipped when unset), honeypot, sign-up / posting limits, new-account cooldown, guest caps. */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-abuse-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.SIGNUP_PER_IP_HOUR = '3'
delete process.env.TURNSTILE_SECRET_KEY
delete process.env.TURNSTILE_SITE_KEY

const { app } = await import('../src/app')
const { migrate, db, run } = await import('../src/db')
const { seed } = await import('./fixtures/seed')
const { resetRateLimits } = await import('../src/util')
const { setTurnstileFetch, hasLink } = await import('../src/abuse')

let ipSeq = 0
async function call(method: string, path: string, o: { body?: unknown; cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { host: 'localhost:5173', 'x-wifly': '1', 'x-forwarded-for': o.ip ?? '10.0.0.1' }
  if (o.cookie) headers.cookie = o.cookie
  let body: string | undefined
  if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body) }
  const r = await app.request(`http://localhost:5173${path}`, { method, headers, body })
  const set = r.headers.get('set-cookie')
  return { status: r.status, body: await r.json().catch(() => null) as any, cookie: set ? set.split(';')[0] : undefined }
}
async function signUp(extra: Record<string, unknown> = {}, ip = `10.1.0.${++ipSeq}`) {
  const acct = privateKeyToAccount(generatePrivateKey())
  const { body: { nonce } } = await call('GET', '/api/auth/nonce', { ip })
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'Sign in to Wifly. No transaction, no fee.', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const signature = await acct.signMessage({ message })
  const r = await call('POST', '/api/auth/verify', { body: { message, signature, ...extra }, ip })
  // no made-up @names, so test accounts pick one like onboarding does
  if (r.status === 200 && r.body?.me?.needsHandle) { const p = await call('PATCH', '/api/me', { body: { handle: 't' + acct.address.slice(2, 14).toLowerCase() }, cookie: r.cookie, ip }); if (p.body?.me) r.body.me = p.body.me }
  return r
}

before(async () => { await migrate(); await seed({ quiet: true }) })
beforeEach(() => { resetRateLimits(); delete process.env.TURNSTILE_SECRET_KEY; setTurnstileFetch(null) })
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('turnstile: skipped when the keys are unset; the config hands out no site key', async () => {
  assert.equal((await signUp()).status, 200)
  assert.equal((await call('GET', '/api/auth/config')).body.turnstile, null)
})

test('turnstile: with a secret set, the token is checked but never blocks sign-up (11.8.3)', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'test-only-not-a-real-secret'
  process.env.TURNSTILE_SITE_KEY = 'site-key-public'
  const seen: string[] = []
  setTurnstileFetch(async (_u, i) => { seen.push(i.body.get('response') ?? ''); return { json: async () => ({ success: i.body.get('response') === 'good' }) } })
  assert.equal((await signUp()).status, 200, 'no token: allowed under ip limits')
  assert.equal((await signUp({ turnstileToken: 'bad' })).status, 200, 'rejected token: allowed under ip limits')
  assert.equal((await signUp({ turnstileToken: 'good' })).status, 200)
  assert.deepEqual(seen, ['bad', 'good'])
  assert.equal((await call('GET', '/api/auth/config')).body.turnstile, 'site-key-public')
  setTurnstileFetch(async () => { throw new Error('network down') })
  assert.equal((await signUp({ turnstileToken: 'good' })).status, 200, 'network error: allowed under ip limits')
  delete process.env.TURNSTILE_SITE_KEY
})

test('honeypot: a filled hidden field blocks sign-up', async () => {
  assert.equal((await signUp({ website: 'http://spam.example' })).status, 400)
  assert.equal((await signUp({ website: '' })).status, 200)
})

test('sign-up is rate-limited per IP', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await signUp({}, '10.9.9.9')).status, 200)
  assert.equal((await signUp({}, '10.9.9.9')).status, 429)
  assert.equal((await signUp({}, '10.9.9.10')).status, 200, 'other IPs are fine')
})

test('new accounts wait before posting links or tipping; plain posts are fine', async () => {
  const s = await signUp()
  const plain = await call('POST', '/api/drops', { body: { text: 'hello flat world' }, cookie: s.cookie })
  assert.equal(plain.status, 201)
  const link = await call('POST', '/api/drops', { body: { text: 'see https://example.com' }, cookie: s.cookie })
  assert.equal(link.status, 429)
  assert.match(link.body.error, /new accounts/)
  const tip = await call('POST', `/api/drops/${plain.body.drop.id}/tips`, { body: { amount: 5 }, cookie: s.cookie })
  assert.equal(tip.status, 429)
  // an hour later the cooldown is over
  await run('UPDATE users SET created_at = ? WHERE handle = ?', [Date.now() - 3_600_000, s.body.me.handle])
  assert.equal((await call('POST', '/api/drops', { body: { text: 'see https://example.com' }, cookie: s.cookie })).status, 201)
})

test('posting is rate-limited per account', async () => {
  const s = await signUp()
  let last = 0
  for (let i = 0; i < 31; i++) last = (await call('POST', '/api/drops', { body: { text: `note ${i}` }, cookie: s.cookie })).status
  assert.equal(last, 429)
})

test('guest reads: capped preview, no paging, rate-limited per IP', async () => {
  const f = await call('GET', '/api/feed', { ip: '10.7.7.7' })
  assert.equal(f.body.items.length, 8)
  assert.equal(f.body.guest.more, true)
  const handle = f.body.items[0].author.handle
  const p = await call('GET', `/api/users/${handle}`, { ip: '10.7.7.7' })
  assert.equal(p.status, 200, 'public profiles are open')
  let st = 200
  for (let i = 0; i < 130 && st === 200; i++) st = (await call('GET', '/api/trending', { ip: '10.7.7.8' })).status
  assert.equal(st, 429)
})

test('link detector', () => {
  for (const t of ['https://x.io', 'www.site.com', 'go to cheap.xyz now']) assert.ok(hasLink(t), t)
  for (const t of ['hello world', 'name.wif is mine', 'gm. 3.5 WIF']) assert.ok(!hasLink(t), t)
})
