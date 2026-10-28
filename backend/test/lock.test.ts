/** Lock rules: an x or a wallet belongs to one wifly account for good. Signing in with one opens that account, empty leftovers fold in, real accounts never merge, no unlink. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-lock-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET; delete process.env.ADMIN_ADDRESSES
delete process.env.DCA_KEEPER_ENABLED; delete process.env.NAMES_CONTRACT_ADDRESS

const { app, setLeftoverBalanceCheckForTests } = await import('../src/app')
let funded = false
setLeftoverBalanceCheckForTests(async () => funded)
const { migrate, run, one, all } = await import('../src/db')
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
const me = async (cookie: string) => (await call('GET', '/api/me', { cookie })).body.me
const onboard = async (cookie: string, handle: string) => assert.equal((await call('POST', '/api/onboarding', { body: { handle }, cookie })).status, 200)
type Id = { did: string; xUserId?: string | null; xUsername?: string | null; email?: string | null; embeddedWallet?: string | null }
const ident = (id: Id) => ({ xName: id.xUsername ?? null, smartWallet: null, xUserId: null, xUsername: null, email: null, embeddedWallet: null, ...id, wallets: id.embeddedWallet ? [id.embeddedWallet] : [] })
async function linkPrivy(cookie: string, id: Id) {
  resetRateLimits(); setPrivyVerifierForTests(() => ident(id) as never)
  try { return await call('POST', '/api/auth/link/privy', { body: { identityToken: 'x'.repeat(40) }, cookie }) } finally { setPrivyVerifierForTests(null) }
}
async function privySignIn(id: Id) {
  resetRateLimits(); setPrivyVerifierForTests(() => ident(id) as never)
  try { const r = await call('POST', '/api/auth/privy', { body: { identityToken: 'x'.repeat(40) } }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.cookie! } finally { setPrivyVerifierForTests(null) }
}
const linkWallet = async (cookie: string, acct: PrivateKeyAccount) => { resetRateLimits(); return call('POST', '/api/auth/link/wallet', { body: await siwe(acct, 'link this wallet to my wifly account.'), cookie }) }

const lc = (a: string) => a.toLowerCase()
const MARV_X = '1748335146913185793'

test('marvpeggy links x @marvreum from settings: the empty leftover holding that x folds in, x then opens marvpeggy', async () => {
  // the leftover: an x sign-in that never picked a name and holds nothing
  const left = await privySignIn({ did: 'did:privy:marvreum', xUserId: MARV_X, xUsername: 'Marvreum' })
  const leftMe = await me(left)
  assert.equal(leftMe.onboarded, false)
  const leftId = Number((await one<{ user_id: number }>('SELECT user_id FROM privy_accounts WHERE x_user_id = ?', [MARV_X]))!.user_id)
  // the real account: a wallet sign-in with a name
  const w = key()
  const c = await signIn(w); await onboard(c, 'marvpeggy')
  const realId = Number((await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', ['marvpeggy']))!.id)
  assert.notEqual(realId, leftId)
  const r = await linkPrivy(c, { did: 'did:privy:marvreum', xUserId: MARV_X, xUsername: 'Marvreum' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.me.handle, 'marvpeggy')
  assert.equal(r.body.me.links.x, 'Marvreum')
  // the x row now sits on marvpeggy; the leftover is soft-deleted (backed up), not hard-deleted
  const rows = await all<{ user_id: number }>('SELECT user_id FROM privy_accounts WHERE x_user_id = ?', [MARV_X])
  assert.deepEqual(rows.map(x => Number(x.user_id)), [realId])
  assert.ok((await one<{ deleted_at: number }>('SELECT deleted_at FROM users WHERE id = ?', [leftId]))!.deleted_at)
  assert.ok(await one('SELECT 1 FROM deleted_users WHERE user_id = ?', [leftId]))
  // signing in (or "signing up") with that x now opens marvpeggy, onboarded: no /welcome, no new account
  const before = Number((await one<{ n: number }>('SELECT count(*) AS n FROM users'))!.n)
  const again = await me(await privySignIn({ did: 'did:privy:marvreum', xUserId: MARV_X, xUsername: 'Marvreum' }))
  assert.equal(again.handle, 'marvpeggy'); assert.equal(again.onboarded, true)
  // and under a fresh privy did too (the same x signing up again)
  const fresh = await me(await privySignIn({ did: 'did:privy:marvreum-new', xUserId: MARV_X, xUsername: 'Marvreum' }))
  assert.equal(fresh.handle, 'marvpeggy'); assert.equal(fresh.onboarded, true)
  // the wallet sign-in opens it as well
  assert.equal((await me(await signIn(w))).handle, 'marvpeggy')
  assert.equal(Number((await one<{ n: number }>('SELECT count(*) AS n FROM users'))!.n), before)
})

test('linking an x that is on another real account: 409 with a lowercase line, nothing moves', async () => {
  const a = await signIn(key()); await onboard(a, 'lockowner')
  assert.equal((await linkPrivy(a, { did: 'did:privy:lockx', xUserId: '77001', xUsername: 'lock_x' })).status, 200)
  const b = await signIn(key()); await onboard(b, 'lockother')
  const r = await linkPrivy(b, { did: 'did:privy:lockx', xUserId: '77001', xUsername: 'lock_x' })
  assert.equal(r.status, 409)
  assert.equal(r.body.error, 'this x is already on @lockowner')
  assert.equal(r.body.error, r.body.error.toLowerCase())
  assert.equal((await me(a)).links.x, 'lock_x'); assert.equal((await me(b)).links.x, null)
})

test('a wallet on another real account: 409, and signing in with it opens that account', async () => {
  const w = key()
  const a = await signIn(w); await onboard(a, 'walletlock')
  const b = await signIn(key()); await onboard(b, 'walletother')
  const r = await linkWallet(b, w)
  assert.equal(r.status, 409); assert.equal(r.body.error, 'this wallet is already on @walletlock')
  assert.equal((await me(await signIn(w))).handle, 'walletlock')
})

test('a nameless account that holds something is real: a follow, or ETH / $WIF on its wallet, keeps it from folding', async () => {
  const x1 = await privySignIn({ did: 'did:privy:busy1', xUserId: '88001', xUsername: 'busy1' })
  const target = await signIn(key()); await onboard(target, 'followed1')
  const tid = Number((await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', ['followed1']))!.id)
  const bid = Number((await one<{ user_id: number }>('SELECT user_id FROM privy_accounts WHERE x_user_id = ?', ['88001']))!.user_id)
  await run('INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)', [bid, tid, Date.now()])
  void x1
  const c = await signIn(key()); await onboard(c, 'wantsbusy1')
  const r = await linkPrivy(c, { did: 'did:privy:busy1', xUserId: '88001', xUsername: 'busy1' })
  assert.equal(r.status, 409); assert.equal(r.body.error, 'this x is already on another wifly account')
  // funded leftover: no fold either
  await privySignIn({ did: 'did:privy:busy2', xUserId: '88002', xUsername: 'busy2', embeddedWallet: lc(key().address) })
  funded = true
  try { assert.equal((await linkPrivy(c, { did: 'did:privy:busy2', xUserId: '88002', xUsername: 'busy2' })).status, 409) } finally { funded = false }
  // chain unreadable: nothing folds, the person is asked to try again
  setLeftoverBalanceCheckForTests(async () => null)
  try {
    const u = await linkPrivy(c, { did: 'did:privy:busy2', xUserId: '88002', xUsername: 'busy2' })
    assert.equal(u.status, 503); assert.match(u.body.error, /try again/)
  } finally { setLeftoverBalanceCheckForTests(async () => funded) }
  // once it reads empty, it folds
  assert.equal((await linkPrivy(c, { did: 'did:privy:busy2', xUserId: '88002', xUsername: 'busy2' })).status, 200)
})

test('no unlink: there is no route that takes an x or a wallet off an account', async () => {
  const c = await signIn(key()); await onboard(c, 'nounlink')
  for (const [m, p] of [['POST', '/api/auth/unlink'], ['POST', '/api/auth/unlink/x'], ['POST', '/api/auth/unlink/wallet'], ['DELETE', '/api/auth/link/privy'], ['DELETE', '/api/auth/link/wallet'], ['DELETE', '/api/wallets']] as const) {
    const r = await call(m, p, { cookie: c, body: {} })
    assert.ok(r.status === 404 || r.status === 405, `${m} ${p} -> ${r.status}`)
  }
  const routes = (app as any).routes.map((r: any) => `${r.method} ${r.path}`).join('\n')
  assert.doesNotMatch(routes, /unlink/i)
})

test('sign-out revokes the session on the server: the old cookie opens nothing, another sign-in of the same account still works', async () => {
  const w = key()
  const a1 = await signIn(w); await onboard(a1, 'switcha')
  const a2 = await signIn(w)
  assert.notEqual(a1, a2) // each sign-in has its own token
  assert.equal((await me(a1)).handle, 'switcha')
  const out = await call('POST', '/api/auth/logout', { cookie: a1 })
  assert.equal(out.status, 200)
  assert.equal((await me(a1)), null) // replaying the signed-out cookie: signed out
  assert.equal((await call('POST', '/api/drops', { cookie: a1, body: { text: 'late write from the old session' } })).status, 401)
  assert.equal((await me(a2)).handle, 'switcha')
  // then a different account in the same browser sees only itself
  const b = await signIn(key()); await onboard(b, 'switchb')
  assert.equal((await me(b)).handle, 'switchb')
})
