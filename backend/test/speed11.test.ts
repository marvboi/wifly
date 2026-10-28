/** No seeding, name gating, guest linking (wallet + X) with 409s, /u redirects, share fallback. `npm test` */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-s11-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.RETIRE_ASS_HANDLE
delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET

const { app } = await import('../src/app')
const { migrate, db, run, one } = await import('../src/db')
const { resetRateLimits } = await import('../src/util')
const { RESERVED } = await import('../src/features')
const paths = await import('../../frontend/src/lib/paths')
const share = await import('../../frontend/src/lib/share')
const jose = await import('jose')

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
async function siwe(acct: PrivateKeyAccount, statement = 'Sign in to Wifly. No transaction, no fee.') {
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement, uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  return { message, signature: await acct.signMessage({ message }) }
}
const signInWith = async (acct: PrivateKeyAccount) => call('POST', '/api/auth/verify', { body: await siwe(acct) })
const newAcct = () => privateKeyToAccount(generatePrivateKey())
const uidOf = async (cookie: string) => Number((await one<{ id: number }>('SELECT id FROM users WHERE address = ?', [(await call('GET', '/api/me', { cookie })).body.me.address]))?.id)

before(async () => { await migrate() })
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('no seeding: a fresh server has no users, no @ass, and signed-out reads are empty', async () => {
  assert.equal(Number((await one<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n), 0)
  assert.equal(Number((await one<{ n: number }>('SELECT COUNT(*) AS n FROM drops'))!.n), 0)
  assert.equal((await call('GET', '/api/me')).body.me, null, 'signed out is nobody, not a default user')
  assert.equal((await call('GET', '/api/users/ass')).status, 404)
  const src = readFileSync(resolve(import.meta.dirname, '../src/server.ts'), 'utf8')
  assert.doesNotMatch(src, /\bseed\(/, 'the server never seeds')
})

test('name gating: new accounts have no public @name until they pick one', async () => {
  resetRateLimits()
  const r = await signInWith(newAcct())
  assert.equal(r.status, 200)
  assert.equal(r.body.me.handle, '')
  assert.ok(!String(r.body.me.name).startsWith('~'), 'the hidden placeholder never shows as a name')
  assert.equal(r.body.me.needsHandle, true)
  assert.equal(r.body.me.renaming, false)
  const hidden = (await one<{ handle: string }>('SELECT handle FROM users WHERE address = ?', [r.body.me.address]))!.handle
  assert.ok(hidden.startsWith('~'))
  assert.equal((await call('GET', `/api/users/${encodeURIComponent(hidden)}`)).status, 404, 'placeholder is never public')
  assert.equal((await call('POST', '/api/drops', { body: { text: 'hi' }, cookie: r.cookie })).status, 403)
  const ok = await call('POST', '/api/onboarding', { body: { handle: 'firstname' }, cookie: r.cookie })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.me.needsHandle, false)
  assert.equal((await call('GET', '/api/users/firstname')).status, 200)
})

test('auto-named users from older builds are asked to pick a name (renaming), nothing deleted', async () => {
  resetRateLimits()
  const acct = newAcct()
  await run(`INSERT INTO users (address, handle, name, onboarded, created_at) VALUES (?, 'wif_ab12cd', 'old', 1, 1)`, [acct.address.toLowerCase()])
  const r = await signInWith(acct)
  assert.equal(r.body.me.needsHandle, true)
  assert.equal(r.body.me.renaming, true)
  const p = await call('PATCH', '/api/me', { body: { handle: 'oldtimer' }, cookie: r.cookie })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  assert.equal(p.body.me.handle, 'oldtimer')
  assert.equal(p.body.me.needsHandle, false)
  // keeping the auto name on purpose also counts as picking it
  const acct2 = newAcct()
  await run(`INSERT INTO users (address, handle, name, onboarded, created_at) VALUES (?, 'wif_99887766', 'k', 1, 1)`, [acct2.address.toLowerCase()])
  const r2 = await signInWith(acct2)
  const keep = await call('PATCH', '/api/me', { body: { handle: 'wif_99887766' }, cookie: r2.cookie })
  assert.equal(keep.body.me.needsHandle, false)
})

test('guest links a wallet: same account from the guest key or the wallet; someone else’s wallet is a clear 409', async () => {
  resetRateLimits()
  const guest = newAcct(), wallet = newAcct()
  const g = await signInWith(guest)
  await call('PATCH', '/api/me', { body: { handle: 'guesty' }, cookie: g.cookie })
  const before = await uidOf(g.cookie!)
  const l = await call('POST', '/api/auth/link/wallet', { body: { ...(await siwe(wallet, 'link this wallet to my wifly account.')), guest: true }, cookie: g.cookie })
  assert.equal(l.status, 200, JSON.stringify(l.body))
  assert.equal(l.body.me.address, wallet.address.toLowerCase())
  assert.deepEqual(l.body.me.links.wallets, [wallet.address.toLowerCase()])
  const viaWallet = await signInWith(wallet), viaGuest = await signInWith(guest)
  assert.equal(viaWallet.body.me.handle, 'guesty')
  assert.equal(viaGuest.body.me.handle, 'guesty', 'the guest key still opens the same account')
  assert.equal(Number((await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', ['guesty']))!.id), before)

  const other = await signInWith(newAcct())
  const taken = await call('POST', '/api/auth/link/wallet', { body: await siwe(wallet, 'link this wallet to my wifly account.'), cookie: other.cookie })
  assert.equal(taken.status, 409)
  assert.equal(taken.body.error, 'this wallet is already on @guesty')
  assert.equal(taken.body.error, taken.body.error.toLowerCase())
})

test('guest links X: the Privy login joins the same account; the same X on another account is a 409', async () => {
  resetRateLimits()
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true })
  process.env.PRIVY_APP_ID = 'test-app'
  process.env.PRIVY_VERIFICATION_KEY = await jose.exportSPKI(publicKey)
  const mint = (did: string, xid: string, user: string) => new jose.SignJWT({ linked_accounts: JSON.stringify([{ type: 'twitter_oauth', subject: xid, username: user, name: user, pfp: null, lv: 1 }]), cr: '1' })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' }).setIssuer('privy.io').setAudience('test-app').setSubject(did).setIssuedAt().setExpirationTime('1h').sign(privateKey)
  try {
    const g = await signInWith(newAcct())
    await call('PATCH', '/api/me', { body: { handle: 'xguest' }, cookie: g.cookie })
    const tok = await mint('did:privy:s11a', '5550001', 'xguest_x')
    const l = await call('POST', '/api/auth/link/privy', { body: { identityToken: tok }, cookie: g.cookie })
    assert.equal(l.status, 200, JSON.stringify(l.body))
    assert.equal(l.body.me.links.x, 'xguest_x')
    const back = await call('POST', '/api/auth/privy', { body: { identityToken: tok } })
    assert.equal(back.body.me.handle, 'xguest', 'signing in with X later opens the same account')

    const other = await signInWith(newAcct())
    const taken = await call('POST', '/api/auth/link/privy', { body: { identityToken: tok }, cookie: other.cookie })
    assert.equal(taken.status, 409)
    assert.equal(taken.body.error, 'this x is already on @xguest')
    // same X id under a different Privy user is still someone else's
    const dup = await call('POST', '/api/auth/link/privy', { body: { identityToken: await mint('did:privy:s11b', '5550001', 'xguest_x') }, cookie: other.cookie })
    assert.equal(dup.status, 409)
    assert.equal((await call('POST', '/api/auth/link/privy', { body: { identityToken: tok } })).status, 401, 'linking needs a signed-in account')

    // access-token fallback without the app secret: a clear 503, not a crash
    delete process.env.PRIVY_APP_SECRET
    const at = await call('POST', '/api/auth/privy', { body: { accessToken: 'a'.repeat(40) } })
    assert.equal(at.status, 503)
    assert.match(at.body.error, /identity tokens/)
  } finally { delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_VERIFICATION_KEY }
})

test('profile urls: /@name, plain /name unless it is a route word, /u/name redirects', () => {
  assert.equal(paths.profilePath('marv'), '/@marv')
  assert.equal(paths.postPath('abc', 'marv'), '/@marv/post/abc')
  assert.equal(paths.postPath('abc', '~1f'), '/post/abc')
  assert.equal(paths.postPath('abc'), '/post/abc')
  assert.equal(paths.handleFromSegment('@Marv'), 'marv')
  assert.equal(paths.handleFromSegment('marv'), 'marv')
  assert.equal(paths.handleFromSegment('settings'), null)
  assert.equal(paths.handleFromSegment('docs'), null)
  assert.equal(paths.legacyProfileRedirect('/u/marv'), '/@marv')
  assert.equal(paths.legacyProfileRedirect('/u/marv/following'), '/@marv/following')
  assert.equal(paths.legacyProfileRedirect('/home'), null)
  for (const w of paths.ROUTE_WORDS) if (/^[a-z0-9_]{3,20}$/.test(w)) assert.ok(RESERVED.has(w), `route word "${w}" is reserved as a handle`)
  const caddy = readFileSync(resolve(import.meta.dirname, '../../frontend/Caddyfile'), 'utf8')
  assert.match(caddy, /redir @legacyProfileQ \/@\{re\.legacyProfileQ\.1\}\?\{query\} 301/)
  assert.match(caddy, /redir @legacyProfile \/@\{re\.legacyProfile\.1\} 301/)
})

test('share: system sheet first, clipboard fallback with a lowercase "link copied", quiet on cancel', async () => {
  const copied: string[] = []
  const clip = { writeText: async (s: string) => { copied.push(s) } }
  assert.equal(await share.shareLink('https://app.wifly.fun/@marv/post/1', undefined, { share: async () => {}, ...clip }), 'shared')
  assert.equal(await share.shareLink('u1', undefined, { share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }) }, ...clip }), 'cancelled')
  assert.equal(await share.shareLink('u2', undefined, { share: async () => { throw new Error('not allowed') }, ...clip }), 'copied')
  assert.equal(await share.shareLink('u3', undefined, clip), 'copied')
  assert.deepEqual(copied, ['u2', 'u3'])
  assert.equal(await share.shareLink('u4', undefined, {}), 'failed')
  assert.equal(share.shareToast('copied'), 'link copied')
  assert.equal(share.shareToast('shared'), null)
  assert.equal(share.shareToast('cancelled'), null)
  const t = share.shareToast('failed')!; assert.equal(t, t.toLowerCase())
})
