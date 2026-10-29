/** Guests browse, set up a profile and link; every other write is a 403 'link_required' until a wallet, x or email is linked. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-s114-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET; delete process.env.ADMIN_ADDRESSES

const { app } = await import('../src/app')
const { migrate } = await import('../src/db')
const { resetRateLimits } = await import('../src/util')
const { setPrivyVerifierForTests } = await import('../src/privy')
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
async function siwe(acct: PrivateKeyAccount, extra: Record<string, unknown> = {}) {
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'Sign in to Wifly. No transaction, no fee.', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  return { message, signature: await acct.signMessage({ message }), ...extra }
}
async function signIn(acct: PrivateKeyAccount, extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/auth/verify', { body: await siwe(acct, extra) })
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.cookie!
}
const key = () => privateKeyToAccount(generatePrivateKey())
const fakeTx = '0x' + 'ab'.repeat(32)

/** A creator with a drop, and a guest with a picked @name. */
async function setup(tag: string) {
  resetRateLimits()
  const creator = await signIn(key())
  assert.equal((await call('PATCH', '/api/me', { body: { handle: `maker${tag}` }, cookie: creator })).status, 200)
  const d = await call('POST', '/api/drops', { body: { text: 'hello world' }, cookie: creator })
  assert.equal(d.status, 201, JSON.stringify(d.body))
  const guestKey = key()
  const guest = await signIn(guestKey, { guest: true })
  return { creator, dropId: d.body.drop.id as string, guestKey, guest, maker: `maker${tag}` }
}

/** Every gated write a guest could try: like, repost, tip, reply, post, follow, subscribe, unlock, vote, names, promote, plus, agent, dca. */
const gated = (dropId: string, maker: string): [string, string, unknown][] => [
  ['POST', `/api/drops/${dropId}/like`, {}],
  ['DELETE', `/api/drops/${dropId}/like`, undefined],
  ['POST', `/api/drops/${dropId}/pass`, {}],
  ['POST', `/api/drops/${dropId}/tips`, { txHash: fakeTx, amount: 1 }],
  ['POST', '/api/drops', { text: 'a reply', replyTo: dropId }],
  ['POST', '/api/drops', { text: 'my first drop' }],
  ['DELETE', `/api/drops/${dropId}`, undefined],
  ['POST', `/api/users/${maker}/follow`, {}],
  ['DELETE', `/api/users/${maker}/follow`, undefined],
  ['POST', '/api/plus/payments', { txHash: fakeTx }],
  ['POST', '/api/plus/auto-renew', { on: true }],
  ['PUT', '/api/me/tiers', { tiers: [] }],
  ['POST', '/api/badges/burns', { txHash: fakeTx }],
  ['POST', '/api/names/claim', { name: 'guestname', txHash: fakeTx }],
  ['POST', '/api/names/guestname/buy', { txHash: fakeTx }],
  ['POST', '/api/names/guestname/list', { price: 10 }],
  ['DELETE', '/api/names/guestname/list', undefined],
  ['POST', '/api/names/guestname/offers', { amount: 5 }],
  ['POST', '/api/names/guestname/primary', {}],
  ['POST', '/api/names/use', { name: 'guestname' }],
  ['POST', '/api/me/name', { name: 'guestname' }],
  ['POST', '/api/settings/tips', { mode: 'wallet' }],
  ['POST', '/api/wallet/proof', {}],
  ['POST', '/api/x/attest', {}],
  ['PUT', '/api/agent/cap', { cap: 10 }],
  ['POST', '/api/agent/plan', { text: 'promote 5' }],
  ['POST', '/api/agent/execute', { text: 'tip @a 1' }],
  ['POST', '/api/agent/deposit', { txHash: fakeTx }],
  ['POST', '/api/dca/plans', { amount: 1 }],
]

test('a guest gets 403 link_required on every gated write, and nothing is written', async () => {
  const { guest, dropId, maker } = await setup('a')
  assert.equal((await call('PATCH', '/api/me', { body: { handle: 'guesta' }, cookie: guest })).status, 200)
  for (const [m, p, b] of gated(dropId, maker)) {
    resetRateLimits()
    const r = await call(m, p, { body: b, cookie: guest })
    assert.equal(r.status, 403, `${m} ${p} → ${r.status} ${JSON.stringify(r.body)}`)
    assert.equal(r.body.code, 'link_required', `${m} ${p}`)
    assert.equal(r.body.error, r.body.error.toLowerCase())
  }
  const d = await call('GET', `/api/drops/${dropId}`, { cookie: guest })
  assert.equal(d.body.drop.likes, 0); assert.equal(d.body.drop.replies, 0)
  assert.equal((await call('GET', '/api/me', { cookie: guest })).body.me.guest, true)
})

test('a guest can still browse, set up the profile, bookmark, mute, read notifications and sign out', async () => {
  const { guest, dropId, maker } = await setup('b')
  assert.equal((await call('GET', '/api/feed', { cookie: guest })).status, 200)
  assert.equal((await call('GET', `/api/users/${maker}`, { cookie: guest })).status, 200)
  assert.equal((await call('PATCH', '/api/me', { body: { handle: 'guestb', name: 'guest b', bio: 'hi' }, cookie: guest })).status, 200)
  assert.equal((await call('POST', '/api/onboarding', { body: { name: 'guest b' }, cookie: guest })).status, 200)
  assert.equal((await call('POST', `/api/drops/${dropId}/bookmark`, { body: {}, cookie: guest })).status, 200)
  assert.equal((await call('POST', `/api/drops/${dropId}/not-interested`, { body: {}, cookie: guest })).status, 200)
  assert.equal((await call('POST', `/api/users/${maker}/mute`, { body: {}, cookie: guest })).status, 200)
  assert.equal((await call('POST', '/api/notifications/read', { body: {}, cookie: guest })).status, 200)
  assert.equal((await call('POST', '/api/auth/logout', { body: {}, cookie: guest })).status, 200)
})

test('after linking a wallet the same writes go through (like, repost, reply, post, follow) and none say link_required', async () => {
  const { guest, dropId, maker } = await setup('c')
  assert.equal((await call('PATCH', '/api/me', { body: { handle: 'guestc' }, cookie: guest })).status, 200)
  const l = await call('POST', '/api/auth/link/wallet', { body: { ...(await siwe(key())), guest: true }, cookie: guest })
  assert.equal(l.status, 200, JSON.stringify(l.body))
  assert.equal(l.body.me.guest, false)
  const cookie = l.cookie ?? guest
  const ok: Record<string, number> = {
    [`POST /api/drops/${dropId}/like`]: 200, [`DELETE /api/drops/${dropId}/like`]: 200, [`POST /api/drops/${dropId}/pass`]: 200,
    [`POST /api/users/${maker}/follow`]: 200, [`DELETE /api/users/${maker}/follow`]: 200,
  }
  for (const [m, p, b] of gated(dropId, maker)) {
    if (m === 'DELETE' && p === `/api/drops/${dropId}`) continue // someone else's drop: a plain 403/404, not a link prompt
    resetRateLimits()
    const r = await call(m, p, { body: b, cookie })
    assert.notEqual(r.body?.code, 'link_required', `${m} ${p} still gated`)
    const want = ok[`${m} ${p}`] ?? (p === '/api/drops' ? 201 : undefined)
    if (want) assert.equal(r.status, want, `${m} ${p} → ${r.status} ${JSON.stringify(r.body)}`)
  }
  const d = await call('GET', `/api/drops/${dropId}`, { cookie })
  assert.equal(d.body.drop.replies, 1)
  assert.equal(d.body.drop.passes ?? d.body.drop.reposts ?? 1, 1)
})

test('linking x (or email) through privy also lifts the gate; a plain wallet sign-up was never gated', async () => {
  const { guest, dropId, maker } = await setup('d')
  assert.equal((await call('POST', `/api/drops/${dropId}/like`, { body: {}, cookie: guest })).status, 403)
  setPrivyVerifierForTests(() => ({ did: 'did:privy:s114', xUserId: null, xUsername: null, xName: null, email: 'a@b.co', smartWallet: null, embeddedWallet: null, wallets: [] }) as any)
  const l = await call('POST', '/api/auth/link/privy', { body: { identityToken: 'x'.repeat(40) }, cookie: guest })
  setPrivyVerifierForTests(null)
  assert.equal(l.status, 200, JSON.stringify(l.body))
  assert.equal((await call('POST', `/api/drops/${dropId}/like`, { body: {}, cookie: l.cookie ?? guest })).status, 200)
  const plain = await signIn(key())
  assert.equal((await call('POST', `/api/users/${maker}/follow`, { body: {}, cookie: plain })).status, 200)
  assert.equal((await call('GET', '/api/me', { cookie: plain })).body.me.guest, false)
})
