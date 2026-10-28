/** An existing account signing in through privy with an external wallet (no embedded wallet) lands on that account, never a new one. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-s1151-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET; delete process.env.ADMIN_ADDRESSES
delete process.env.DCA_KEEPER_ENABLED

const { app, setLeftoverBalanceCheckForTests } = await import('../src/app')
setLeftoverBalanceCheckForTests(async () => false) // leftovers here hold no ETH or $WIF
const { migrate, run, one } = await import('../src/db')
const { resetRateLimits } = await import('../src/util')
const { setPrivyVerifierForTests } = await import('../src/privy')
const { startDcaKeeper } = await import('../src/dca')
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
const me = async (cookie: string) => (await call('GET', '/api/me', { cookie })).body.me ?? (await call('GET', '/api/me', { cookie })).body
const privy = async (id: Record<string, unknown>) => {
  setPrivyVerifierForTests(() => ({ xUserId: null, xUsername: null, xName: null, email: null, smartWallet: null, embeddedWallet: null, wallets: [], ...id }) as any)
  const r = await call('POST', '/api/auth/privy', { body: { identityToken: 'x'.repeat(40) } })
  setPrivyVerifierForTests(null)
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r
}
const users = async () => Number((await one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL', []))!.n)

async function realUser(handle: string) {
  resetRateLimits()
  const acct = privateKeyToAccount(generatePrivateKey())
  const c = await signIn(acct)
  assert.equal((await call('POST', '/api/onboarding', { body: { handle } , cookie: c })).status, 200)
  const m = await me(c)
  assert.equal(m.handle, handle); assert.equal(m.onboarded, true)
  return { acct, id: m.id as string, cookie: c }
}

test('a wallet user signing in through privy with that same external wallet (no embedded wallet) lands on their account, not /welcome', async () => {
  const u = await realUser('walletmarv')
  const before = await users()
  // the privy "wallet" login: the external wallet shows up in wallets[] only, checksummed
  const r = await privy({ did: 'did:privy:marv-ext', wallets: [u.acct.address] })
  const m = await me(r.cookie!)
  assert.equal(m.id, u.id, 'same account')
  assert.equal(m.handle, 'walletmarv'); assert.equal(m.onboarded, true); assert.equal(m.needsHandle, false)
  assert.equal(await users(), before, 'no new account')
})

test('wallet match is case-insensitive even when an older row stored the checksummed address', async () => {
  const u = await realUser('mixedcase')
  await run('UPDATE users SET address = ? WHERE address = ?', [u.acct.address, u.acct.address.toLowerCase()])
  const r = await privy({ did: 'did:privy:mixed', wallets: [u.acct.address.toLowerCase()] })
  assert.equal((await me(r.cookie!)).handle, 'mixedcase')
  // and siwe still finds it
  assert.equal((await me(await signIn(u.acct))).handle, 'mixedcase')
})

test('a second linked wallet (user_wallets) also finds the account through privy', async () => {
  const u = await realUser('twowallets')
  const extra = privateKeyToAccount(generatePrivateKey()).address
  const row = await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', ['twowallets'])
  await run('INSERT INTO user_wallets (user_id, address, created_at) VALUES (?, ?, ?)', [row!.id, extra.toLowerCase(), Date.now()])
  const r = await privy({ did: 'did:privy:second', wallets: [extra] })
  assert.equal((await me(r.cookie!)).handle, 'twowallets')
})

test('an empty account made by an earlier privy wallet login is skipped: the next sign-in lands on the real account, nothing deleted', async () => {
  const u = await realUser('realmarv')
  // simulate the old bug on live: this did was already mapped to a fresh empty account
  resetRateLimits()
  const shell = await run('INSERT INTO users (address, handle, name, tone, created_at) VALUES (NULL, ?, ?, 0, ?)', ['~pending' + Date.now().toString(36), '', Date.now()])
  const shellId = Number(shell.lastInsertRowid)
  await run('INSERT INTO privy_accounts (did, user_id, wallet, updated_at) VALUES (?, ?, NULL, ?)', ['did:privy:oldbug', shellId, Date.now()])
  const r = await privy({ did: 'did:privy:oldbug', wallets: [u.acct.address] })
  const m = await me(r.cookie!)
  assert.equal(m.handle, 'realmarv'); assert.equal(m.onboarded, true)
  // the empty account is untouched (not deleted) and the privy login now points at the real one
  assert.ok(await one('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', [shellId]), 'empty account left alone')
  assert.equal(Number((await one<{ user_id: number }>('SELECT user_id FROM privy_accounts WHERE did = ?', ['did:privy:oldbug']))!.user_id), Number((await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', ['realmarv']))!.id))
  // and again: stable
  assert.equal((await me((await privy({ did: 'did:privy:oldbug', wallets: [u.acct.address] })).cookie!)).handle, 'realmarv')
})

test('x user id and email find the account under a new privy did', async () => {
  resetRateLimits()
  const a = await privy({ did: 'did:privy:xfirst', xUserId: '4242', xUsername: 'xperson', email: 'Me@Example.com' })
  assert.equal((await call('POST', '/api/onboarding', { body: { handle: 'xperson' }, cookie: a.cookie })).status, 200)
  const before = await users()
  assert.equal((await me((await privy({ did: 'did:privy:xagain', xUserId: '4242' })).cookie!)).handle, 'xperson')
  assert.equal((await me((await privy({ did: 'did:privy:mailagain', email: 'me@example.com' })).cookie!)).handle, 'xperson')
  assert.equal(await users(), before)
})

test('a brand-new wallet still gets a fresh account and the name step; linking that wallet later folds the empty account in', async () => {
  resetRateLimits()
  const fresh = privateKeyToAccount(generatePrivateKey())
  const c = await signIn(fresh)
  const m = await me(c)
  assert.equal(m.needsHandle, true); assert.equal(m.onboarded, false)
  const freshRow = await one<{ id: number }>('SELECT id FROM users WHERE address = ?', [fresh.address.toLowerCase()])
  // "already have an account? sign in with x or email instead": sign out, sign in to the real account, link this wallet
  await call('POST', '/api/auth/logout', { cookie: c })
  const u = await realUser('folder')
  const { body: { nonce } } = await call('GET', '/api/auth/nonce', { cookie: u.cookie })
  const message = createSiweMessage({ domain: 'localhost:5173', address: fresh.address, statement: 'Link this wallet to Wifly. No transaction, no fee.', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const l = await call('POST', '/api/auth/link/wallet', { body: { message, signature: await fresh.signMessage({ message }) }, cookie: u.cookie })
  assert.equal(l.status, 200, JSON.stringify(l.body))
  assert.equal((await me(await signIn(fresh))).handle, 'folder', 'the wallet now signs in to the real account')
  assert.ok(await one('SELECT id FROM users WHERE id = ? AND deleted_at IS NOT NULL', [freshRow!.id]), 'the empty account was folded (soft)')
})

test('dca keeper stays off unless DCA_KEEPER_ENABLED is exactly "true", and status says what really runs', async () => {
  assert.equal(startDcaKeeper(), 'off')
  const k = (await call('GET', '/api/dca/keeper')).body
  assert.equal(k.enabled, false); assert.equal(k.flag, false); assert.equal(k.state, 'off')
  process.env.DCA_KEEPER_ENABLED = 'true'; delete process.env.WIFLY_KEEPER_PRIVATE_KEY
  const s = startDcaKeeper()
  assert.ok(s === 'no-contract' || s === 'no-signer')
  const k2 = (await call('GET', '/api/dca/keeper')).body
  assert.equal(k2.flag, true); assert.equal(k2.enabled, false, 'flag on but nothing running is not "enabled"')
  delete process.env.DCA_KEEPER_ENABLED
})
