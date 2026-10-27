import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-id-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
// bot friction is covered in abuse.test.ts; these suites create many accounts from one IP
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.NAMES_CONTRACT_ADDRESS; delete process.env.BADGES_CONTRACT_ADDRESS; delete process.env.WIFLY_CONTRACT_ADDRESS
delete process.env.REDIS_URL

const { app } = await import('../src/app')
const { migrate, db, run, one } = await import('../src/db')
const { seed } = await import('./fixtures/seed')
const { resetRateLimits } = await import('../src/util')

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
async function signIn() {
  const acct = privateKeyToAccount(generatePrivateKey())
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'Sign in to Wifly. No transaction, no fee.', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const r = await call('POST', '/api/auth/verify', { body: { message, signature: await acct.signMessage({ message }) } })
  // no made-up @names, so test accounts pick one like onboarding does
  if (r.body?.me) { const p = await call('PATCH', '/api/me', { body: { handle: 't' + acct.address.slice(2, 14).toLowerCase() }, cookie: r.cookie }); if (p.body?.me) r.body.me = p.body.me }
  if (!r.body?.me) throw new Error('sign-in failed: ' + r.status + ' ' + JSON.stringify(r.body))
  return { cookie: r.cookie!, me: r.body.me, uid: Number((await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', [r.body.me.handle]))!.id) }
}
const TX = `0x${'ab'.repeat(32)}`

const { redirectAllowed, handleHolder, settleBumps, GRACE_MS } = await import('../src/identity')
const { resetNameOnTransfer } = await import('../src/features')
before(async () => { await migrate(); await seed({ quiet: true }) })
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('redirect rule: only while nobody else has the old name', () => {
  assert.equal(redirectAllowed({ historyUser: null, activeHandleUser: null, nameOwner: null }), false)
  assert.equal(redirectAllowed({ historyUser: 7, activeHandleUser: null, nameOwner: 7 }), true, 'kept or listed but unsold')
  assert.equal(redirectAllowed({ historyUser: 7, activeHandleUser: null, nameOwner: null }), true, 'released, not yet claimed')
  assert.equal(redirectAllowed({ historyUser: 7, activeHandleUser: null, nameOwner: 9 }), false, 'sold or claimed by someone else')
  assert.equal(redirectAllowed({ historyUser: 7, activeHandleUser: 9, nameOwner: null }), false, 'someone uses it as their @name')
})


test('handle holder rule: owning x.wif wins @x after the free holder’s grace', () => {
  const now = 1_000
  assert.deepEqual(handleHolder({ freeHolder: 5, wifOwner: null, bumpRenameBy: null, now }), { holder: 5, bump: 'none' }, 'free @name, nobody owns the .wif')
  assert.deepEqual(handleHolder({ freeHolder: 5, wifOwner: 5, bumpRenameBy: null, now }), { holder: 5, bump: 'none' }, 'you own your own .wif')
  assert.deepEqual(handleHolder({ freeHolder: 5, wifOwner: 9, bumpRenameBy: now + 1, now }), { holder: 5, bump: 'grace' }, 'grace: the free holder keeps @x for now')
  assert.deepEqual(handleHolder({ freeHolder: 5, wifOwner: 9, bumpRenameBy: now, now }), { holder: 9, bump: 'expired' }, 'grace over: the owner holds @x')
  assert.deepEqual(handleHolder({ freeHolder: null, wifOwner: 9, bumpRenameBy: null, now }), { holder: 9, bump: 'none' })
})

test('sign-up gives a free @name (no NFT); "make it yours onchain" claims name.wif and sets it primary', async () => {
  resetRateLimits()
  const u = await signIn()
  const ob = await call('POST', '/api/onboarding', { cookie: u.cookie, body: { handle: 'First_Pick', name: 'Pat' } })
  assert.equal(ob.status, 200, JSON.stringify(ob.body))
  assert.equal(ob.body.me.handle, 'first_pick', 'case-insensitive, stored lowercase')
  assert.equal(await one('SELECT 1 FROM names WHERE name = ?', ['first_pick']), undefined, 'a free @name mints nothing')
  assert.equal(ob.body.me.wifName ?? null, null, 'free users have no .wif tag')
  const other = await signIn()
  assert.equal((await call('GET', '/api/handles/check?h=FIRST_PICK', { cookie: other.cookie })).body.available, false, 'unique regardless of case')
  const id0 = await call('GET', '/api/me/identity', { cookie: u.cookie })
  assert.equal(id0.body.nudge.display, 'first_pick.wif', 'nudge: claim first_pick.wif before someone else does')
  assert.equal(id0.body.bump, null)
  // make it yours onchain: claim + setPrimary (preview mirror, no tx is invented)
  const mk = await call('POST', '/api/names/claim', { cookie: u.cookie, body: { name: 'first_pick', primary: true } })
  assert.equal(mk.status, 201, JSON.stringify(mk.body))
  assert.equal(mk.body.me.wifName, 'first_pick')
  assert.equal((await call('GET', '/api/me/identity', { cookie: u.cookie })).body.nudge, null)
  // .wif owners change their @ by switching their main .wif, not with a free rename
  assert.equal((await call('PATCH', '/api/me', { cookie: u.cookie, body: { handle: 'something_else' } })).status, 409)
  const post = await call('POST', '/api/drops', { cookie: u.cookie, body: { text: 'hello from my first name' } })
  assert.equal(post.status, 201)
  assert.equal((await call('POST', '/api/names/claim', { cookie: u.cookie, body: { name: 'second_pick' } })).status, 201)
  const sw = await call('POST', '/api/me/name', { cookie: u.cookie, body: { name: 'second_pick', old: 'list', price: 250 } })
  assert.equal(sw.status, 200, JSON.stringify(sw.body))
  assert.equal(sw.body.me.handle, 'second_pick')
  assert.deepEqual(sw.body.old, { name: 'first_pick', listed: true, price: 250 })
  const drops = await call('GET', '/api/users/second_pick/drops', { cookie: u.cookie })
  assert.ok(drops.body.items.some((d: any) => d.drop?.text === 'hello from my first name' || d.text === 'hello from my first name'), 'same account, posts stay')
  assert.deepEqual((await call('GET', '/api/users/first_pick')).body, { redirect: 'second_pick' })
  assert.deepEqual((await call('GET', '/api/users/first_pick.wif')).body, { redirect: 'second_pick' }, 'name.wif links work too')
  assert.equal((await call('GET', '/api/users/second_pick')).body.formerly.name, 'first_pick')
  assert.equal((await call('POST', '/api/me/name', { cookie: u.cookie, body: { name: 'noravale' } })).status, 403)
  // someone else gets the old .wif: the old-link redirect stops; @first_pick now points at its owner
  await run('DELETE FROM name_listings WHERE name = ?', ['first_pick'])
  await run('UPDATE names SET owner_id = ? WHERE name = ?', [other.uid, 'first_pick'])
  const oh = (await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [other.uid]))!.handle
  assert.deepEqual((await call('GET', '/api/users/first_pick')).body, { redirect: oh }, 'owning x.wif holds @x')
  assert.equal((await call('POST', '/api/names/first_pick/primary', { cookie: other.cookie })).status, 200)
  assert.equal((await call('GET', '/api/users/first_pick')).body.user.handle, 'first_pick')
})

test('sign-up blocks a free @name whose .wif someone else owns', async () => {
  resetRateLimits()
  const owner = await signIn()
  await call('POST', '/api/onboarding', { cookie: owner.cookie, body: { handle: 'owner_free' } })
  await call('POST', '/api/names/claim', { cookie: owner.cookie, body: { name: 'owner_free' } }) // main .wif; the next claim isn't primary
  assert.equal((await call('POST', '/api/names/claim', { cookie: owner.cookie, body: { name: 'taken_onchain' } })).status, 201)
  const u = await signIn()
  const chk = await call('GET', '/api/handles/check?h=taken_onchain', { cookie: u.cookie })
  assert.equal(chk.body.available, false)
  assert.equal(chk.body.reason, 'wif-owned')
  assert.equal((await call('POST', '/api/onboarding', { cookie: u.cookie, body: { handle: 'taken_onchain' } })).status, 409)
})

test('someone else claims your name’s .wif: notice + grace, then rename keeps posts and followers; owner gets @x', async () => {
  resetRateLimits()
  const free = await signIn(), owner = await signIn()
  await call('POST', '/api/onboarding', { cookie: free.cookie, body: { handle: 'bumpy' } })
  await call('POST', '/api/onboarding', { cookie: owner.cookie, body: { handle: 'owner_two' } })
  await call('POST', '/api/drops', { cookie: free.cookie, body: { text: 'still mine after the rename' } })
  await call('POST', `/api/users/bumpy/follow`, { cookie: owner.cookie })
  const cl = await call('POST', '/api/names/claim', { cookie: owner.cookie, body: { name: 'bumpy', primary: true } })
  assert.equal(cl.status, 201, 'no reservation: anyone can claim it')
  assert.equal(cl.body.me.handle, 'owner_two', 'during grace the free holder keeps @bumpy')
  assert.equal(cl.body.me.wifName, 'bumpy')
  const id = await call('GET', '/api/me/identity', { cookie: free.cookie })
  assert.equal(id.body.bump.handle, 'bumpy')
  assert.ok(id.body.bump.renameBy - id.body.bump.since === GRACE_MS)
  assert.equal(id.body.nudge, null)
  assert.ok(await one(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'handle_bump'`, [free.uid]), 'gentle notice')
  // rename during grace: free, keeps the account; the owner gets @bumpy right away
  const rn = await call('PATCH', '/api/me', { cookie: free.cookie, body: { handle: 'bumpy_new' } })
  assert.equal(rn.status, 200, JSON.stringify(rn.body))
  assert.equal((await call('GET', '/api/users/bumpy')).body.user.handle, 'bumpy', 'owner holds @bumpy now')
  assert.equal((await call('GET', '/api/users/bumpy')).body.user.wifName, 'bumpy')
  const d = await call('GET', '/api/users/bumpy_new/drops', { cookie: free.cookie })
  assert.ok(d.body.items.some((x: any) => (x.drop?.text ?? x.text) === 'still mine after the rename'))
  assert.equal((await call('GET', '/api/me/identity', { cookie: free.cookie })).body.bump, null)
})

test('grace runs out: the free holder moves to a fallback, the owner gets @x, no redirect to the old holder', async () => {
  resetRateLimits()
  const free = await signIn(), owner = await signIn()
  await call('POST', '/api/onboarding', { cookie: free.cookie, body: { handle: 'slowpoke' } })
  await call('POST', '/api/onboarding', { cookie: owner.cookie, body: { handle: 'owner_three' } })
  await call('POST', '/api/names/claim', { cookie: owner.cookie, body: { name: 'slowpoke', primary: true } })
  await settleBumps(Date.now() + GRACE_MS + 1)
  const h = (await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [free.uid]))!.handle
  assert.match(h, /^slowpoke_\d+$/)
  assert.equal((await call('GET', '/api/users/slowpoke')).body.user.handle, 'slowpoke')
  assert.equal((await call('GET', '/api/users/slowpoke')).body.user.wifName, 'slowpoke')
})

test('selling your main .wif: you keep the @ as a free name until the buyer makes it primary', async () => {
  resetRateLimits()
  const s = await signIn(), b = await signIn()
  await call('POST', '/api/onboarding', { cookie: s.cookie, body: { handle: 'seller_free' } })
  await call('POST', '/api/onboarding', { cookie: b.cookie, body: { handle: 'buyer_free' } })
  await call('POST', '/api/names/claim', { cookie: s.cookie, body: { name: 'seller_free', primary: true } })
  await run('UPDATE names SET owner_id = ? WHERE name = ?', [b.uid, 'seller_free'])
  await resetNameOnTransfer('seller_free', s.uid)
  assert.equal((await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [s.uid]))!.handle, 'seller_free')
  assert.equal((await call('GET', '/api/me/identity', { cookie: s.cookie })).body.wifName, null, 'primary cleared on transfer')
  assert.equal((await call('POST', '/api/names/seller_free/primary', { cookie: b.cookie })).status, 200)
  assert.equal((await call('GET', '/api/me/identity', { cookie: s.cookie })).body.bump.handle, 'seller_free', 'seller gets the notice + grace')
})

test('switching back to an old .wif clears its redirect', async () => {
  resetRateLimits()
  const u = await signIn()
  await call('POST', '/api/onboarding', { cookie: u.cookie, body: { handle: 'loop_a' } })
  await call('POST', '/api/names/claim', { cookie: u.cookie, body: { name: 'loop_a' } })
  await call('POST', '/api/names/claim', { cookie: u.cookie, body: { name: 'loop_b' } })
  await call('POST', '/api/me/name', { cookie: u.cookie, body: { name: 'loop_b', old: 'keep' } })
  assert.deepEqual((await call('GET', '/api/users/loop_a')).body, { redirect: 'loop_b' })
  await call('POST', '/api/me/name', { cookie: u.cookie, body: { name: 'loop_a', old: 'keep' } })
  assert.equal((await call('GET', '/api/users/loop_a')).body.user.handle, 'loop_a')
  assert.deepEqual((await call('GET', '/api/users/loop_b')).body, { redirect: 'loop_a' })
})
