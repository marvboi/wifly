/** One account holds x + email + several wallets, linked in any order; leftovers fold in, real accounts never merge; main and receiving switch with a signature. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-s1161-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET; delete process.env.ADMIN_ADDRESSES
delete process.env.DCA_KEEPER_ENABLED; delete process.env.NAMES_CONTRACT_ADDRESS

const { app, setLeftoverBalanceCheckForTests } = await import('../src/app')
setLeftoverBalanceCheckForTests(async () => false) // leftovers here hold no ETH or $WIF
const { migrate, run, one } = await import('../src/db')
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
const addrs = (m: any) => (m.links.walletList as any[]).map(w => w.address)
const lc = (a: string) => a.toLowerCase()
async function prove(cookie: string, purpose: 'main' | 'tips', signer: PrivateKeyAccount, address = signer.address) {
  const p = await call('POST', '/api/wallet/proof', { body: { purpose, address }, cookie })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  return { address, nonce: p.body.nonce, signature: await signer.signMessage({ message: p.body.message }) }
}

test('link x after a wallet sign-in: the main wallet, the x and its embedded wallet all show on one account', async () => {
  const w = key(), emb = key()
  const c = await signIn(w); await onboard(c, 'walletfirst')
  const l = await linkPrivy(c, { did: 'did:privy:wf', xUserId: '9101', xUsername: 'wf_x', embeddedWallet: lc(emb.address) })
  assert.equal(l.status, 200, JSON.stringify(l.body))
  const m = await me(c)
  assert.equal(m.links.x, 'wf_x')
  assert.deepEqual(addrs(m), [lc(w.address), lc(emb.address)])
  const [main, privy] = m.links.walletList
  assert.equal(main.main, true); assert.equal(main.receiving, true); assert.equal(main.kind, 'main')
  assert.equal(privy.privy, true); assert.equal(privy.kind, 'privy'); assert.equal(privy.main, false)
  // later, x alone opens the same account
  assert.equal((await me(await privySignIn({ did: 'did:privy:wf', xUserId: '9101', xUsername: 'wf_x', embeddedWallet: lc(emb.address) }))).handle, 'walletfirst')
})

test('a privy wallet login first, then x under a different privy user: merges instead of a 409, both still sign in', async () => {
  const w = key(), e1 = key(), e2 = key()
  const c = await signIn(w); await onboard(c, 'twodids')
  assert.equal((await linkPrivy(c, { did: 'did:privy:walletonly', embeddedWallet: lc(e1.address) })).status, 200)
  const l = await linkPrivy(c, { did: 'did:privy:withx', xUserId: '9202', xUsername: 'two_x', embeddedWallet: lc(e2.address) })
  assert.equal(l.status, 200, JSON.stringify(l.body))
  const m = await me(c)
  assert.equal(m.links.x, 'two_x')
  for (const a of [w, e1, e2]) assert.ok(addrs(m).includes(lc(a.address)))
  assert.equal((await me(await privySignIn({ did: 'did:privy:walletonly', embeddedWallet: lc(e1.address) }))).handle, 'twodids')
  assert.equal((await me(await privySignIn({ did: 'did:privy:withx', xUserId: '9202', xUsername: 'two_x', embeddedWallet: lc(e2.address) }))).handle, 'twodids')
  // a second, different x is refused: one x per account
  const x2 = await linkPrivy(c, { did: 'did:privy:otherx', xUserId: '9203', xUsername: 'other_x' })
  assert.equal(x2.status, 409); assert.match(x2.body.error, /already has x @two_x/)
})

test('link a wallet after an x sign-in; linking it again says already linked', async () => {
  const emb = key(), w = key()
  const c = await privySignIn({ did: 'did:privy:xfirst', xUserId: '9301', xUsername: 'xfirst', embeddedWallet: lc(emb.address) })
  await onboard(c, 'xfirst')
  const l = await linkWallet(c, w)
  assert.equal(l.status, 200, JSON.stringify(l.body)); assert.notEqual(l.body.already, true)
  const m = await me(c)
  assert.ok(addrs(m).includes(lc(w.address))); assert.ok(addrs(m).includes(lc(emb.address)))
  assert.equal(m.links.x, 'xfirst')
  const again = await linkWallet(c, w)
  assert.equal(again.status, 200); assert.equal(again.body.already, true)
  assert.equal((await me(await signIn(w))).handle, 'xfirst')
})

test('x already on an empty leftover account folds in; its embedded wallet comes along', async () => {
  const emb = key(), w = key()
  const leftover = await privySignIn({ did: 'did:privy:left', xUserId: '9401', xUsername: 'lefty', embeddedWallet: lc(emb.address) })
  assert.ok(leftover)
  const leftId = (await one<any>("SELECT user_id FROM privy_accounts WHERE did = 'did:privy:left'"))!.user_id
  const c = await signIn(w); await onboard(c, 'keeper')
  const l = await linkPrivy(c, { did: 'did:privy:left', xUserId: '9401', xUsername: 'lefty', embeddedWallet: lc(emb.address) })
  assert.equal(l.status, 200, JSON.stringify(l.body))
  const m = await me(c)
  assert.equal(m.links.x, 'lefty'); assert.ok(addrs(m).includes(lc(emb.address)))
  assert.ok((await one<any>('SELECT deleted_at FROM users WHERE id = ?', [Number(leftId)]))?.deleted_at, 'leftover is soft-deleted (backed up)')
  assert.ok(await one('SELECT 1 FROM deleted_users WHERE user_id = ?', [Number(leftId)]))
})

test('two real accounts never merge: x or wallet on another real account is "this x/wallet is already on @name"', async () => {
  const a = key(), b = key(), emb = key()
  const ca = await signIn(a); await onboard(ca, 'realone')
  assert.equal((await linkPrivy(ca, { did: 'did:privy:real1', xUserId: '9501', xUsername: 'real_x', embeddedWallet: lc(emb.address) })).status, 200)
  const cb = await signIn(b); await onboard(cb, 'realtwo')
  const x = await linkPrivy(cb, { did: 'did:privy:real1b', xUserId: '9501', xUsername: 'real_x' })
  assert.equal(x.status, 409); assert.equal(x.body.error, 'this x is already on @realone')
  const w = await linkWallet(cb, a)
  assert.equal(w.status, 409); assert.equal(w.body.error, 'this wallet is already on @realone')
  // a picked @name with nothing else is still a real account
  const c3 = key(); const cc = await signIn(c3); await onboard(cc, 'justaname')
  const w3 = await linkWallet(cb, c3)
  assert.equal(w3.status, 409); assert.equal(w3.body.error, 'this wallet is already on @justaname')
  for (const h of ['realone', 'realtwo', 'justaname']) assert.ok(await one('SELECT 1 FROM users WHERE handle = ? AND deleted_at IS NULL', [h]), h)
  assert.equal((await me(ca)).links.x, 'real_x')
  assert.equal((await me(cb)).links.x, null)
})

test('switch main and receiving among linked wallets, the privy one included, each with a signature', async () => {
  const m0 = key(), w = key(), emb = key(), stranger = key()
  const c = await signIn(m0); await onboard(c, 'switcher')
  assert.equal((await linkWallet(c, w)).status, 200)
  assert.equal((await linkPrivy(c, { did: 'did:privy:sw', xUserId: '9601', xUsername: 'sw_x', embeddedWallet: lc(emb.address) })).status, 200)

  // a signature from another wallet doesn't count
  const bad = await prove(c, 'main', stranger, w.address)
  assert.equal((await call('POST', '/api/settings/main', { body: bad, cookie: c })).status, 401)
  // a wallet not on this account can't become main
  assert.equal((await call('POST', '/api/settings/main', { body: await prove(c, 'main', stranger), cookie: c })).status, 400)

  const r = await call('POST', '/api/settings/main', { body: await prove(c, 'main', w), cookie: c })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  let m = await me(c)
  const byAddr = (a: string) => m.links.walletList.find((x: any) => x.address === lc(a))
  assert.equal(byAddr(w.address).main, true)
  assert.equal(byAddr(m0.address).main, false); assert.ok(byAddr(m0.address), 'old main stays linked')
  assert.equal(byAddr(m0.address).receiving, true, 'tips keep landing where they did')
  assert.equal((await me(await signIn(m0))).handle, 'switcher', 'old main still signs in')

  // receiving moves to the embedded privy wallet (signed by it)
  const t = await call('POST', '/api/settings/tips', { body: await prove(c, 'tips', emb), cookie: c })
  assert.equal(t.status, 200, JSON.stringify(t.body))
  m = await me(c)
  assert.equal(byAddr(emb.address).receiving, true); assert.equal(byAddr(m0.address).receiving, false)
  assert.equal((await call('GET', '/api/users/switcher/payout')).body.address, lc(emb.address))

  // and main can be the privy wallet too; the session isn't touched
  assert.equal((await call('POST', '/api/settings/main', { body: await prove(c, 'main', emb), cookie: c })).status, 200)
  m = await me(c)
  assert.equal(byAddr(emb.address).main, true); assert.equal(byAddr(emb.address).privy, true)
  assert.equal(m.handle, 'switcher')
  assert.equal(new Set(addrs(m)).size, addrs(m).length, 'each wallet listed once')
})

test('me() lists every wallet once, case-insensitively', async () => {
  const w = key()
  const c = await signIn(w); await onboard(c, 'dedupe')
  const uid = Number((await one<any>("SELECT id FROM users WHERE handle = 'dedupe'"))!.id)
  await run(`INSERT INTO privy_accounts (did, user_id, wallet, updated_at) VALUES ('did:privy:dd', ?, ?, ?)`, [uid, w.address, Date.now()])
  const m = await me(c)
  assert.equal(m.links.walletList.length, 1)
  assert.equal(m.links.walletList[0].main, true); assert.equal(m.links.walletList[0].privy, true)
})
