/** profile names tab, settings "your name", plus "opens soon" and the dca time label. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-s116-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET; delete process.env.ADMIN_ADDRESSES
delete process.env.NAMES_CONTRACT_ADDRESS

const { app } = await import('../src/app')
const { migrate, run, one } = await import('../src/db')
const { resetRateLimits } = await import('../src/util')
const { plusOpen } = await import('../../frontend/src/lib/plusOpen')
const { utcLabel } = await import('../../frontend/src/lib/tzLabel')
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
async function signIn(acct: PrivateKeyAccount) {
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'Sign in to Wifly. No transaction, no fee.', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const r = await call('POST', '/api/auth/verify', { body: { message, signature: await acct.signMessage({ message }) } })
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.cookie!
}
async function realUser(handle: string) {
  resetRateLimits()
  const c = await signIn(privateKeyToAccount(generatePrivateKey()))
  assert.equal((await call('POST', '/api/onboarding', { body: { handle }, cookie: c })).status, 200)
  const id = Number((await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', [handle]))!.id)
  return { id, cookie: c }
}
const hold = (name: string, uid: number, at: number) => run('INSERT INTO names (name, owner_id, minted, created_at, theme) VALUES (?, ?, 1, ?, 2)', [name, uid, at])
const setWif = (uid: number, name: string) => run(`UPDATE users SET extras = json_set(coalesce(extras, '{}'), '$.wifName', ?) WHERE id = ?`, [name, uid])

test('names tab: every .wif a person holds, current first, public listings only, never "@name.wif"', async () => {
  const u = await realUser('namesowner')
  await hold('zeta', u.id, 1); await hold('namesowner', u.id, 2); await hold('quiet', u.id, 3)
  await setWif(u.id, 'namesowner')
  await run('INSERT INTO name_listings (name, seller_id, price, created_at) VALUES (?, ?, ?, ?)', ['zeta', u.id, 250, 1])
  await run('INSERT INTO name_listings (name, seller_id, price, buyer_id, created_at) VALUES (?, ?, ?, ?, ?)', ['quiet', u.id, 99, u.id, 1])
  const r = await call('GET', '/api/users/namesowner/names')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.names.map((n: any) => n.name), ['namesowner', 'zeta', 'quiet'])
  assert.equal(r.body.names[0].current, true); assert.equal(r.body.names[0].display, 'namesowner.wif')
  assert.deepEqual(r.body.names[1].listing, { price: 250 })
  assert.equal(r.body.names[2].listing, null, 'a private listing is not shown')
  assert.ok(!JSON.stringify(r.body).includes('@namesowner.wif'))
  // the profile shows the name only because it's held (server-checked)
  const p = await call('GET', '/api/users/namesowner')
  assert.equal((p.body.user ?? p.body).wifName, 'namesowner')
  // ".wif" or "@" in the path still finds the person
  assert.equal((await call('GET', '/api/users/@namesowner.wif/names')).body.names.length, 3)
})

test('names tab: someone without a .wif gets an empty list, not an error', async () => {
  await realUser('nonames')
  const r = await call('GET', '/api/users/nonames/names')
  assert.equal(r.status, 200); assert.deepEqual(r.body.names, [])
})

test('settings "your name": usable is a held .wif that is not the current name, else null', async () => {
  const u = await realUser('holder')
  await hold('holder', u.id, 1); await setWif(u.id, 'holder')
  let r = await call('GET', '/api/names/mine', { cookie: u.cookie })
  assert.equal(r.status, 200); assert.equal(r.body.current, 'holder'); assert.equal(r.body.usable, null, 'only the current name: no "use it"')
  await hold('spare', u.id, 2)
  r = await call('GET', '/api/names/mine', { cookie: u.cookie })
  assert.equal(r.body.usable, 'spare')
  const n = await realUser('plainuser')
  r = await call('GET', '/api/names/mine', { cookie: n.cookie })
  assert.equal(r.body.current, null); assert.equal(r.body.usable, null)
})

test('plus opens only once the onchain price is set (0 = opens soon), month and year separately', () => {
  assert.deepEqual(plusOpen(true, true, 0n, 0n), { monthOpen: false, yearOpen: false })
  assert.deepEqual(plusOpen(true, true, 1500n * 10n ** 18n, 0n), { monthOpen: true, yearOpen: false })
  assert.deepEqual(plusOpen(true, true, 1n, 1n), { monthOpen: true, yearOpen: true })
  assert.deepEqual(plusOpen(true, false, undefined, undefined), { monthOpen: false, yearOpen: false }, 'not read yet: not buyable')
  assert.deepEqual(plusOpen(false, false), { monthOpen: true, yearOpen: true }, 'preview stays as it was')
})

test('dca time label is a short utc offset, never a zone name', () => {
  const at = (off: number) => ({ getTimezoneOffset: () => off }) as Date
  assert.equal(utcLabel(at(-60)), 'utc+1')
  assert.equal(utcLabel(at(0)), 'utc')
  assert.equal(utcLabel(at(300)), 'utc-5')
  assert.equal(utcLabel(at(-330)), 'utc+5:30')
  assert.ok(!/\//.test(utcLabel()))
})
