/** Tip sheet x handle lookup: wifly-known handles first, then the X API only with X_BEARER_TOKEN (never a guessed id), cached and rate-limited. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-xl-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET; delete process.env.ADMIN_ADDRESSES
delete process.env.DCA_KEEPER_ENABLED; delete process.env.NAMES_CONTRACT_ADDRESS

const { app } = await import('../src/app')
const { migrate, run, one } = await import('../src/db')
const { resetRateLimits } = await import('../src/util')
const { setXFetchForTests, clearXLookupCache, normHandle } = await import('../src/xlookup')
delete process.env.X_BEARER_TOKEN
await migrate()

type Res = { status: number; body: any; cookie?: string }
async function call(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { host: 'localhost:5173', 'x-wifly': '1' }
  if (opts.cookie) headers.cookie = opts.cookie
  let body: BodyInit | undefined
  if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body) }
  const r = await app.request(`http://localhost:5173${path}`, { method, headers, body })
  const set = r.headers.get('set-cookie')
  return { status: r.status, body: await r.json().catch(() => null), cookie: set ? set.split(';')[0] : undefined }
}
const key = () => privateKeyToAccount(generatePrivateKey())
async function siwe(acct: PrivateKeyAccount, statement = 'Sign in to Wifly. No transaction, no fee.') {
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement, uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  return { message, signature: await acct.signMessage({ message }) }
}
async function signIn(acct: PrivateKeyAccount) {
  resetRateLimits()
  const r = await call('POST', '/api/auth/verify', { body: await siwe(acct) })
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.cookie!
}

const cookie = await signIn(key())
await run(`INSERT INTO users (address, handle, name, avatar, created_at) VALUES ('0x00000000000000000000000000000000000000b1', 'xknown', 'Known Person', '/uploads/k.png', ?)`, [Date.now()])
await run(`INSERT INTO privy_accounts (did, user_id, x_user_id, x_username, updated_at) VALUES ('did:privy:k', (SELECT id FROM users WHERE handle='xknown'), '1748335146913185793', 'KnownOnX', ?)`, [Date.now()])
const look = (h: string, c = cookie) => call('GET', `/api/x/lookup?handle=${encodeURIComponent(h)}`, { cookie: c || undefined })

test('handles are normalised from @, x.com and twitter.com links; junk is refused', async () => {
  assert.equal(normHandle('@KnownOnX'), 'knownonx')
  assert.equal(normHandle('https://x.com/KnownOnX?s=20'), 'knownonx')
  assert.equal(normHandle('twitter.com/knownonx/status/1'), 'knownonx')
  assert.equal(normHandle('www.twitter.com/knownonx'), 'knownonx')
  assert.equal(normHandle('not a handle!'), null)
  assert.equal(normHandle('waytoolonghandle_123'), null)
  const r = await look('bad handle!')
  assert.equal(r.status, 400); assert.equal(r.body.code, 'bad_handle'); assert.equal(r.body.error, r.body.error.toLowerCase())
})

test('signed out: 401', async () => {
  assert.equal((await look('knownonx', '')).status, 401)
})

test('a handle that signed in to wifly with x resolves without any x credential', async () => {
  clearXLookupCache(); resetRateLimits()
  setXFetchForTests(async () => { throw new Error('must not call x') })
  const r = await look('@knownonx')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body, { xUserId: '1748335146913185793', handle: 'knownonx', name: 'Known Person', avatar: '/uploads/k.png', onWifly: true })
  setXFetchForTests(null)
})

test('no X_BEARER_TOKEN: an unknown handle says lookup is off, never invents an id', async () => {
  clearXLookupCache(); resetRateLimits(); delete process.env.X_BEARER_TOKEN
  let called = 0
  setXFetchForTests(async () => { called++; return new Response('{}') })
  const r = await look('someoneelse')
  assert.equal(r.status, 503); assert.equal(r.body.code, 'x_off'); assert.equal(called, 0)
  assert.ok(!('xUserId' in r.body)); assert.equal(r.body.error, r.body.error.toLowerCase())
  setXFetchForTests(null)
})

test('with X_BEARER_TOKEN: x api hit, miss, cache and rate limits', async () => {
  clearXLookupCache(); resetRateLimits(); process.env.X_BEARER_TOKEN = 'test-token'
  let calls = 0, auth = ''
  setXFetchForTests(async (url, init) => {
    calls++; auth = String((init.headers as Record<string, string>).authorization)
    if (url.includes('/by/username/flatearth')) return new Response(JSON.stringify({ data: { id: '44196397', username: 'FlatEarth', name: 'Flat Earth', profile_image_url: 'https://pbs.twimg.com/profile_images/1/a.jpg' } }))
    if (url.includes('/by/username/evil')) return new Response(JSON.stringify({ data: { id: '1', username: 'evil', name: 'e', profile_image_url: 'https://evil.example/x.png' } }))
    return new Response(JSON.stringify({ errors: [{ title: 'Not Found Error' }] }))
  })
  try {
    const a = await look('FlatEarth')
    assert.equal(a.status, 200); assert.equal(a.body.xUserId, '44196397'); assert.equal(a.body.handle, 'flatearth'); assert.equal(a.body.onWifly, false)
    assert.equal(auth, 'Bearer test-token')
    await look('flatearth'); assert.equal(calls, 1, 'second lookup comes from the cache')
    const m = await look('nobodyhere')
    assert.equal(m.status, 404); assert.equal(m.body.code, 'no_such_account'); assert.equal(m.body.error, 'no x account called @nobodyhere')
    await look('nobodyhere'); assert.equal(calls, 2, 'misses are cached too')
    const e = await look('evil'); assert.equal(e.body.avatar, null, 'avatars only from pbs.twimg.com')
    resetRateLimits(); clearXLookupCache()
    let last = 0
    for (let i = 0; i < 31; i++) last = (await look(`h${i}`)).status
    assert.equal(last, 429, 'per-user limit')
  } finally { setXFetchForTests(null); delete process.env.X_BEARER_TOKEN }
})
