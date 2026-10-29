/** 11.8.3: turnstile never blocks sign-up. no / failed token or a siteverify error falls back to per-ip limits (429 past them). */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-1183-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.SIGNUP_UNVERIFIED_PER_IP_10MIN
delete process.env.SIGNUP_UNVERIFIED_PER_IP_DAY

const { app } = await import('../src/app')
const { migrate, db } = await import('../src/db')
const { seed } = await import('./fixtures/seed')
const { resetRateLimits } = await import('../src/util')
const { setTurnstileFetch, verifyTurnstile, signupLimits, SIGNUP_BUSY_MSG, SIGNUP_DAY_MSG } = await import('../src/abuse')
const { setLogSink } = await import('../src/accounts')

let ipSeq = 0
async function call(method: string, path: string, o: { body?: unknown; ip?: string } = {}) {
  const headers: Record<string, string> = { host: 'localhost:5173', 'x-wifly': '1', 'x-forwarded-for': o.ip ?? '10.0.0.1' }
  let body: string | undefined
  if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body) }
  const r = await app.request(`http://localhost:5173${path}`, { method, headers, body })
  return { status: r.status, body: await r.json().catch(() => null) as any }
}
async function signUp(extra: Record<string, unknown> = {}, ip = `10.3.0.${++ipSeq}`) {
  const acct = privateKeyToAccount(generatePrivateKey())
  const { body: { nonce } } = await call('GET', '/api/auth/nonce', { ip })
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'sign in', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const signature = await acct.signMessage({ message })
  return call('POST', '/api/auth/verify', { body: { message, signature, ...extra }, ip })
}
const logs: string[] = []
const good = () => setTurnstileFetch(async (_u, i) => ({ json: async () => ({ success: i.body.get('response') === 'good' }) }))

before(async () => { await migrate(); await seed({ quiet: true }); setLogSink(l => { logs.push(l) }) })
beforeEach(() => {
  resetRateLimits(); logs.length = 0
  process.env.TURNSTILE_SECRET_KEY = 'test-only-not-a-real-secret'
  delete process.env.SIGNUP_UNVERIFIED_PER_IP_10MIN; delete process.env.SIGNUP_UNVERIFIED_PER_IP_DAY; delete process.env.TURNSTILE_VERIFY_TIMEOUT_MS
  good()
})
after(() => { setLogSink(null); setTurnstileFetch(null); delete process.env.TURNSTILE_SECRET_KEY; db.close(); rmSync(dir, { recursive: true, force: true }) })

test('no token: sign-up goes through under the ip limit, and the outcome is logged', async () => {
  const r = await signUp()
  assert.equal(r.status, 200)
  assert.ok(r.body.me)
  assert.ok(logs.some(l => l.includes('[human-check] missing')), logs.join('\n'))
})

test('failed token and siteverify network error: allowed', async () => {
  assert.equal((await signUp({ turnstileToken: 'bad' })).status, 200)
  assert.ok(logs.some(l => l.includes('[human-check] failed')))
  setTurnstileFetch(async () => { throw new Error('network down') })
  assert.equal((await signUp({ turnstileToken: 'good' })).status, 200)
  assert.ok(logs.some(l => l.includes('[human-check] error')))
})

test('a hanging siteverify times out and the sign-up still goes through', async () => {
  process.env.TURNSTILE_VERIFY_TIMEOUT_MS = '50'
  setTurnstileFetch((_u, i) => new Promise((_res, rej) => { i.signal?.addEventListener('abort', () => rej(new Error('aborted'))) }))
  const t0 = Date.now()
  assert.equal(await verifyTurnstile('tok', '1.2.3.4'), 'error')
  assert.ok(Date.now() - t0 < 2000)
  assert.equal((await signUp({ turnstileToken: 'tok' })).status, 200)
})

test('a valid token passes as before and does not use the fallback limits', async () => {
  process.env.SIGNUP_UNVERIFIED_PER_IP_10MIN = '1'
  for (let i = 0; i < 4; i++) assert.equal((await signUp({ turnstileToken: 'good' }, '10.4.4.4')).status, 200)
  assert.ok(logs.some(l => l.includes('[human-check] passed')))
  assert.equal(await verifyTurnstile('good'), 'passed')
})

test('unverified sign-ups past 5 per ip per 10 min get a calm 429; other ips and verified ones still pass', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await signUp({}, '10.5.5.5')).status, 200, `#${i + 1}`)
  const r = await signUp({ turnstileToken: 'bad' }, '10.5.5.5')
  assert.equal(r.status, 429)
  assert.equal(r.body.error, SIGNUP_BUSY_MSG)
  assert.equal(r.body.error, r.body.error.toLowerCase())
  assert.equal((await signUp({ turnstileToken: 'good' }, '10.5.5.5')).status, 200, 'a passing check is not held back')
  assert.equal((await signUp({}, '10.5.5.6')).status, 200, 'other ips are fine')
  assert.ok(logs.some(l => l.includes('limited 10m')))
})

test('daily cap per ip, env-tunable', async () => {
  process.env.SIGNUP_UNVERIFIED_PER_IP_10MIN = '100'
  process.env.SIGNUP_UNVERIFIED_PER_IP_DAY = '3'
  for (let i = 0; i < 3; i++) assert.equal((await signUp({}, '10.6.6.6')).status, 200)
  const r = await signUp({}, '10.6.6.6')
  assert.equal(r.status, 429)
  assert.equal(r.body.error, SIGNUP_DAY_MSG)
})

test('limits: defaults 5 / 10 min, 20 / day, 3000ms; bad values fall back', () => {
  assert.deepEqual(signupLimits(), { ip10m: 5, ipDay: 20, verifyMs: 3000 })
  process.env.SIGNUP_UNVERIFIED_PER_IP_10MIN = 'nope'; process.env.SIGNUP_UNVERIFIED_PER_IP_DAY = '-4'; process.env.TURNSTILE_VERIFY_TIMEOUT_MS = '0'
  assert.deepEqual(signupLimits(), { ip10m: 5, ipDay: 20, verifyMs: 3000 })
})

test('no secret set: the check is skipped and the fallback limits never apply (dev unchanged)', async () => {
  delete process.env.TURNSTILE_SECRET_KEY
  process.env.SIGNUP_UNVERIFIED_PER_IP_10MIN = '1'
  for (let i = 0; i < 3; i++) assert.equal((await signUp({}, '10.7.7.7')).status, 200)
  assert.equal(await verifyTurnstile(undefined), 'skipped')
})
