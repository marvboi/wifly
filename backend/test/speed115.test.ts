/** Logged-out visitors read the app like X: every public GET (feed, explore, profiles, posts, .wif names, market) answers without a session; writes stay gated. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-s115-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET; delete process.env.ADMIN_ADDRESSES

const { app } = await import('../src/app')
const { migrate } = await import('../src/db')
const { resetRateLimits } = await import('../src/util')
await migrate()

type Res = { status: number; body: any; cookie?: string }
async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; noHeader?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = { host: 'localhost:5173' }
  if (!opts.noHeader) headers['x-wifly'] = '1'
  if (opts.cookie) headers.cookie = opts.cookie
  let body: BodyInit | undefined
  if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body) }
  const r = await app.request(`http://localhost:5173${path}`, { method, headers, body })
  const set = r.headers.get('set-cookie')
  return { status: r.status, body: await r.json().catch(() => null), cookie: set ? set.split(';')[0] : undefined }
}
async function signIn(acct: PrivateKeyAccount) {
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'Sign in to Wifly. No transaction, no fee.', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const r = await call('POST', '/api/auth/verify', { body: { message, signature: await acct.signMessage({ message }) } })
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.cookie!
}

resetRateLimits()
const creator = await signIn(privateKeyToAccount(generatePrivateKey()))
assert.equal((await call('PATCH', '/api/me', { body: { handle: 'publicmaker' }, cookie: creator })).status, 200)
const posted = await call('POST', '/api/drops', { body: { text: 'the world is flat and you can read this signed out' }, cookie: creator })
assert.equal(posted.status, 201, JSON.stringify(posted.body))
const dropId = posted.body.drop.id as string
assert.equal((await call('POST', '/api/drops', { body: { text: 'a public reply', replyTo: dropId }, cookie: creator })).status, 201)

test('a logged-out visitor gets the live home feed (no session, no x-wifly header)', async () => {
  for (const tab of ['', '?tab=foryou', '?tab=latest', '?tab=top']) {
    const r = await call('GET', `/api/feed${tab}`, { noHeader: true })
    assert.equal(r.status, 200, `/api/feed${tab} ${JSON.stringify(r.body)}`)
    const drops = r.body.drops ?? r.body.items ?? []
    assert.ok(drops.some((d: any) => d.id === dropId), `the real drop shows up on /api/feed${tab}`)
  }
  // "following" has nobody to follow when signed out: an empty page, never a 401
  const f = await call('GET', '/api/feed?tab=following', { noHeader: true })
  assert.notEqual(f.status, 401); assert.ok(f.status < 500)
})

test('every public read the logged-out app uses answers without a session', async () => {
  const reads = [
    '/api/me', '/api/config', `/api/feed/new?tab=foryou&since=${Date.now() - 60_000}`, `/api/drops/${dropId}`, `/api/drops/${dropId}/replies`,
    '/api/users/publicmaker', '/api/users/publicmaker/drops', '/api/users/publicmaker/followers', '/api/users/publicmaker/following',
    '/api/suggest/users?limit=3', '/api/creators', '/api/trending?limit=6', '/api/search?q=flat', '/api/names/market', '/api/names/check?name=flatworld',
    '/api/plus', '/api/badges/publicmaker', '/api/burn', '/api/users/publicmaker/payout',
  ]
  for (const path of reads) {
    const r = await call('GET', path, { noHeader: true })
    assert.ok(r.status !== 401 && r.status !== 403 && r.status < 500, `${path} -> ${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`)
  }
  const me = await call('GET', '/api/me', { noHeader: true })
  assert.equal(me.body.me, null)
  const profile = await call('GET', '/api/users/publicmaker', { noHeader: true })
  assert.equal(profile.status, 200)
  const post = await call('GET', `/api/drops/${dropId}`, { noHeader: true })
  assert.equal(post.status, 200); assert.equal(post.body.drop?.id ?? post.body.id, dropId)
})

test('writes stay gated for a logged-out visitor', async () => {
  const writes: [string, string, unknown][] = [
    ['POST', `/api/drops/${dropId}/like`, {}], ['POST', '/api/drops', { text: 'nope' }], ['POST', '/api/drops', { text: 'nope', replyTo: dropId }],
    ['POST', '/api/users/publicmaker/follow', {}], ['POST', `/api/drops/${dropId}/tips`, { txHash: '0x' + 'ab'.repeat(32), amount: 1 }],
  ]
  for (const [m, p, b] of writes) {
    const r = await call(m, p, { body: b })
    assert.ok(r.status === 401 || r.status === 403, `${m} ${p} -> ${r.status}`)
  }
  // and nothing landed
  const post = await call('GET', `/api/drops/${dropId}`, { noHeader: true })
  assert.equal((post.body.drop ?? post.body).likes ?? 0, 0)
})
