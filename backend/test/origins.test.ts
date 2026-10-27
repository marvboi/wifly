/** ALLOWED_ORIGINS drives CORS, the SIWE domain/URI check and the session cookie. `npm test` */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-test-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
process.env.ALLOWED_ORIGINS = 'https://wifly.fun, https://app.wifly.fun/,https://wifly-web-production.up.railway.app'
delete process.env.CORS_ORIGINS; delete process.env.SIWE_DOMAINS; delete process.env.COOKIE_SECURE

const { app } = await import('../src/app')
const { migrate, db } = await import('../src/db')
const { ALLOWED_ORIGINS, demoSeedAllowed } = await import('../src/config')

async function signIn(domain: string, uri: string, origin = uri) {
  const acct = privateKeyToAccount(generatePrivateKey())
  const n = await app.request('https://app.wifly.fun/api/auth/nonce', { headers: { host: 'app.wifly.fun', 'x-wifly': '1', origin } })
  const { nonce } = await n.json() as { nonce: string }
  const message = createSiweMessage({ domain, address: acct.address, statement: 'Sign in to Wifly. No transaction, no fee.', uri, version: '1', chainId: 4663, nonce })
  const signature = await acct.signMessage({ message })
  return app.request('https://app.wifly.fun/api/auth/verify', { method: 'POST', headers: { host: domain, origin, 'x-wifly': '1', 'content-type': 'application/json' }, body: JSON.stringify({ message, signature }) })
}

before(async () => { await migrate() })
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('ALLOWED_ORIGINS parses a comma list and trims trailing slashes', () => {
  assert.deepEqual(ALLOWED_ORIGINS, ['https://wifly.fun', 'https://app.wifly.fun', 'https://wifly-web-production.up.railway.app'])
  assert.equal(demoSeedAllowed(), process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEMO_SEED === '1')
})

test('CORS: allowed origins pass, others get no allow-origin header', async () => {
  for (const o of ALLOWED_ORIGINS) {
    const r = await app.request('https://app.wifly.fun/api/auth/nonce', { headers: { origin: o } })
    assert.equal(r.headers.get('access-control-allow-origin'), o)
  }
  const bad = await app.request('https://app.wifly.fun/api/auth/nonce', { headers: { origin: 'https://evil.example' } })
  assert.notEqual(bad.headers.get('access-control-allow-origin'), 'https://evil.example')
})

test('SIWE: every allowed host signs in; foreign domains and mismatched URIs are refused; cookie is Secure', async () => {
  for (const o of ALLOWED_ORIGINS) {
    const r = await signIn(new URL(o).host, o)
    assert.equal(r.status, 200, o)
    const set = r.headers.get('set-cookie') || ''
    assert.match(set, /HttpOnly/i); assert.match(set, /Secure/i); assert.doesNotMatch(set, /Domain=/i)
  }
  assert.equal((await signIn('localhost:5173', 'http://localhost:5173')).status, 401)
  assert.equal((await signIn('evil.example', 'https://evil.example')).status, 401)
  assert.equal((await signIn('app.wifly.fun', 'https://evil.example')).status, 401)
  assert.equal((await signIn('app.wifly.fun', 'https://wifly.fun')).status, 401)
})
