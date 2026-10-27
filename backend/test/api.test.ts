/** Basic API test: runs the real app against a throwaway SQLite file. `npm test` */
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
// bot friction is covered in abuse.test.ts; these suites create many accounts from one IP
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'

const { app } = await import('../src/app')
const { migrate, db } = await import('../src/db')
const { seed } = await import('./fixtures/seed')
const { resetRateLimits } = await import('../src/util')

type Res = { status: number; body: any; cookie?: string }
async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; form?: FormData; host?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { host: opts.host ?? 'localhost:5173', 'x-wifly': '1' }
  if (opts.cookie) headers.cookie = opts.cookie
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body) }
  const r = await app.request(`http://localhost:5173${path}`, { method, headers, body })
  const set = r.headers.get('set-cookie')
  return { status: r.status, body: await r.json().catch(() => null), cookie: set ? set.split(';')[0] : undefined }
}
async function signIn(pk = generatePrivateKey(), domain = 'localhost:5173', pick = true) {
  const acct = privateKeyToAccount(pk)
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain, address: acct.address, statement: 'Sign in to Wifly. No transaction, no fee.', uri: `http://${domain}`, version: '1', chainId: 4663, nonce })
  const signature = await acct.signMessage({ message })
  const r = await call('POST', '/api/auth/verify', { body: { message, signature } })
  // no made-up @names, so test accounts pick one like onboarding does
  if (pick && r.body?.me?.needsHandle) { const p = await call('PATCH', '/api/me', { body: { handle: 't' + acct.address.slice(2, 14).toLowerCase() }, cookie: r.cookie }); if (p.body?.me) r.body.me = p.body.me }
  return { ...r, message, signature, acct }
}

before(async () => { await migrate(); await seed({ quiet: true }) })
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('writes need the x-wifly header (CSRF)', async () => {
  const r = await app.request('http://localhost:5173/api/drops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(r.status, 403)
})

test('signed-out: ranked feed, trending, suggestions and search work; writes 401', async () => {
  const f = await call('GET', '/api/feed?tab=foryou')
  assert.equal(f.status, 200)
  // guests get a capped preview (first 8) and a flag for the "sign up to see more" card
  assert.equal(f.body.items.length, 8)
  assert.equal(f.body.next, null)
  assert.deepEqual(f.body.guest, { limit: 8, more: true })
  const g2 = await call('GET', '/api/feed?tab=foryou&cursor=eyJzIjoxLCJvIjoyMH0')
  assert.equal(g2.body.items.length, 0, 'guests cannot page past the preview')
  const viewer = await signIn()
  const full = await call('GET', '/api/feed?tab=foryou', { cookie: viewer.cookie })
  assert.equal(full.body.items.length, 20)
  assert.ok(full.body.next)
  assert.equal(full.body.guest, undefined)
  const ids = new Set(full.body.items.map((d: any) => d.id))
  assert.equal(ids.size, 20, 'no duplicate drops')
  // author diversity: nobody fills more than 3 of the first 10
  const counts: Record<string, number> = {}
  for (const d of full.body.items.slice(0, 10)) counts[d.author.handle] = (counts[d.author.handle] ?? 0) + 1
  assert.ok(Math.max(...Object.values(counts)) <= 3, JSON.stringify(counts))
  const p2 = await call('GET', `/api/feed?tab=foryou&cursor=${full.body.next}`, { cookie: viewer.cookie })
  assert.equal(p2.status, 200)
  for (const d of p2.body.items) assert.ok(!ids.has(d.id), 'page 2 does not repeat page 1')
  assert.ok((await call('GET', '/api/trending')).body.tags.length > 0)
  assert.ok((await call('GET', '/api/suggest/users?limit=3')).body.users.length === 3)
  const s = await call('GET', '/api/search?q=map')
  assert.ok(s.body.users.length + s.body.drops.length > 0)
  assert.equal((await call('POST', '/api/drops', { body: { text: 'hi' } })).status, 401)
})

test('SIWE sign-in creates a profile, rejects replays and wrong domains', async () => {
  const pk = generatePrivateKey()
  const a = await signIn(pk, 'localhost:5173', false)
  assert.equal(a.status, 200, JSON.stringify(a.body))
  assert.ok(a.cookie?.startsWith('wifly_session='))
  assert.equal(a.body.me.handle, '', 'no made-up @name')
  assert.equal(a.body.me.needsHandle, true)
  assert.equal(a.body.me.onboarded, false)
  const replay = await call('POST', '/api/auth/verify', { body: { message: a.message, signature: a.signature } })
  assert.equal(replay.status, 401)
  const wrong = await signIn(generatePrivateKey(), 'evil.example')
  assert.equal(wrong.status, 401)
  const again = await signIn(pk, 'localhost:5173', false)
  assert.equal(again.body.me.address, a.body.me.address, 'same wallet, same account')
  assert.equal(again.body.me.needsHandle, true)
  // forged signature
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const other = privateKeyToAccount(generatePrivateKey())
  const message = createSiweMessage({ domain: 'localhost:5173', address: other.address, uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const sig = await privateKeyToAccount(pk).signMessage({ message })
  assert.equal((await call('POST', '/api/auth/verify', { body: { message, signature: sig } })).status, 401)
})

test('profile, drops, likes, replies, passes, quotes, bookmarks, delete, notifications', async () => {
  resetRateLimits()
  const me = (await signIn()).cookie!
  const ed = await call('PATCH', '/api/me', { cookie: me, body: { handle: 'flatfan', name: 'Flat Fan', bio: 'here for the maps' } })
  assert.equal(ed.status, 200, JSON.stringify(ed.body))
  assert.equal(ed.body.me.handle, 'flatfan')
  assert.equal((await call('PATCH', '/api/me', { cookie: me, body: { handle: 'noravale' } })).status, 409)

  const tooLong = await call('POST', '/api/drops', { cookie: me, body: { text: 'x'.repeat(401) } })
  assert.equal(tooLong.status, 400)
  const d = await call('POST', '/api/drops', { cookie: me, body: { text: 'my first drop on the flat side #flatmap @junoflat' } })
  assert.equal(d.status, 201)
  const id = d.body.drop.id
  assert.deepEqual(d.body.drop.tags, ['flatmap'])

  // Fresh own drop is at the top of For You and in Following.
  const fy = await call('GET', '/api/feed?tab=foryou', { cookie: me })
  assert.equal(fy.body.items[0].id, id)
  const fo = await call('GET', '/api/feed?tab=following', { cookie: me })
  assert.equal(fo.body.items[0].id, id)

  // Another user likes, replies, passes, quotes, follows, tips.
  const other = (await signIn()).cookie!
  await call('PATCH', '/api/me', { cookie: other, body: { handle: 'mapreader', name: 'Map Reader' } })
  const l1 = await call('POST', `/api/drops/${id}/like`, { cookie: other })
  assert.equal(l1.body.drop.likes, 1); assert.equal(l1.body.drop.liked, true)
  const l2 = await call('POST', `/api/drops/${id}/like`, { cookie: other })
  assert.equal(l2.body.drop.likes, 1, 'like is idempotent')
  const rep = await call('POST', '/api/drops', { cookie: other, body: { text: 'welcome!', replyTo: id } })
  assert.equal(rep.status, 201)
  await call('POST', `/api/drops/${id}/pass`, { cookie: other })
  const q = await call('POST', '/api/drops', { cookie: other, body: { text: 'look at this', quoteOf: id } })
  assert.equal(q.body.drop.quote.id, id)
  await call('POST', '/api/users/flatfan/follow', { cookie: other })
  await call('POST', `/api/drops/${id}/tips`, { cookie: other, body: { amount: 50 } })

  const page = await call('GET', `/api/drops/${id}`, { cookie: me })
  assert.equal(page.body.drop.likes, 1)
  assert.equal(page.body.drop.replies, 1)
  assert.equal(page.body.drop.passes, 1)
  assert.equal(page.body.drop.quotes, 1)
  assert.equal(page.body.drop.tipped, 0, 'preview tips do not change public totals')
  assert.equal(page.body.replies[0].text, 'welcome!')
  const thread = await call('GET', `/api/drops/${rep.body.drop.id}`)
  assert.equal(thread.body.ancestors[0].id, id)

  const n = await call('GET', '/api/notifications', { cookie: me })
  const kinds = n.body.items.map((x: any) => x.kind).sort()
  assert.deepEqual(kinds, ['follow', 'like', 'pass', 'quote', 'reply', 'tip'])
  assert.equal((await call('GET', '/api/me', { cookie: me })).body.unread, 6)
  await call('POST', '/api/notifications/read', { cookie: me })
  assert.equal((await call('GET', '/api/me', { cookie: me })).body.unread, 0)
  const juno = await call('GET', '/api/users/junoflat')
  assert.ok(juno.body.user)

  // Unlike reconciles.
  const ul = await call('DELETE', `/api/drops/${id}/like`, { cookie: other })
  assert.equal(ul.body.drop.likes, 0); assert.equal(ul.body.drop.liked, false)

  // Bookmarks.
  await call('POST', `/api/drops/${id}/bookmark`, { cookie: other })
  assert.equal((await call('GET', '/api/bookmarks', { cookie: other })).body.items[0].id, id)

  // Following tab for 'other' shows flatfan's drop.
  const of = await call('GET', '/api/feed?tab=following', { cookie: other })
  assert.ok(of.body.items.some((x: any) => x.id === id))

  // Not interested + mute hide drops.
  const target = fy.body.items.find((x: any) => !x.mine)
  await call('POST', `/api/drops/${target.id}/not-interested`, { cookie: me })
  const fy2 = await call('GET', '/api/feed?tab=foryou', { cookie: me })
  assert.ok(!fy2.body.items.some((x: any) => x.id === target.id))
  await call('POST', '/api/users/junoflat/mute', { cookie: me })
  const fy3 = await call('GET', '/api/feed?tab=foryou', { cookie: me })
  assert.ok(!fy3.body.items.some((x: any) => x.author.handle === 'junoflat'))

  // Only the author can delete; deleting fixes counts and removes it from search.
  assert.equal((await call('DELETE', `/api/drops/${id}`, { cookie: other })).status, 403)
  assert.equal((await call('DELETE', `/api/drops/${rep.body.drop.id}`, { cookie: other })).status, 200)
  assert.equal((await call('GET', `/api/drops/${id}`)).body.drop.replies, 0)
  assert.equal((await call('DELETE', `/api/drops/${id}`, { cookie: me })).status, 200)
  assert.equal((await call('POST', `/api/drops/${id}/like`, { cookie: other })).status, 404)
  const s = await call('GET', '/api/search?q=first%20drop&type=drops')
  assert.ok(!s.body.drops.some((x: any) => x.id === id))
})

test('ranking learns tag interest from likes', async () => {
  resetRateLimits()
  const me = (await signIn()).cookie!
  await call('PATCH', '/api/me', { cookie: me, body: { handle: 'musicfan', name: 'Music Fan' } })
  const tagged = (await call('GET', '/api/search?q=%23music&type=drops')).body.drops
  const before = (await call('GET', '/api/feed?tab=foryou', { cookie: me })).body.items.map((d: any) => d.tags.includes('music')).filter(Boolean).length
  for (const d of tagged.slice(0, 4)) await call('POST', `/api/drops/${d.id}/like`, { cookie: me })
  const after_ = (await call('GET', '/api/feed?tab=foryou', { cookie: me })).body.items.map((d: any) => d.tags.includes('music')).filter(Boolean).length
  assert.ok(after_ >= before, `music drops in first page: before ${before}, after ${after_}`)
})

test('new accounts have no placeholder name: they show as their @username until they pick one', async () => {
  resetRateLimits()
  const r = await signIn()
  assert.equal(r.status, 200)
  assert.notEqual(r.body.me.name, 'new on wifly')
  assert.equal(r.body.me.name, r.body.me.handle)
  const ob = await call('POST', '/api/onboarding', { cookie: r.cookie, body: { name: 'Marv Ade' } })
  assert.equal(ob.status, 200, JSON.stringify(ob.body))
  assert.equal((await call('GET', '/api/me', { cookie: r.cookie })).body.me?.name ?? (await call('GET', '/api/me', { cookie: r.cookie })).body.name, 'Marv Ade')
})

test('profile photos (kind=avatar) go up to 20 MB; post media stays at 5 MB', async () => {
  resetRateLimits()
  const me = (await signIn()).cookie!
  const pngHead = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
  const sized = (bytes: number) => { const b = Buffer.alloc(bytes); pngHead.copy(b); const fd = new FormData(); fd.set('file', new File([b], 'p.png', { type: 'image/png' })); return fd }
  const MB = 1024 * 1024
  // 8 MB: too big for post media, fine for an avatar
  const post8 = await call('POST', '/api/uploads', { cookie: me, form: sized(8 * MB) })
  assert.equal(post8.status, 413)
  const av8 = await call('POST', '/api/uploads?kind=avatar', { cookie: me, form: sized(8 * MB) })
  assert.equal(av8.status, 200, JSON.stringify(av8.body))
  assert.match(av8.body.url, /^\/uploads\/.+\.png$/)
  // just over 20 MB: refused with the plain message
  const av21 = await call('POST', '/api/uploads?kind=avatar', { cookie: me, form: sized(20 * MB + 1) })
  assert.equal(av21.status, 413)
  assert.match(JSON.stringify(av21.body), /photo must be under 20 MB/)
  // type checks still apply to avatars
  const svg = new FormData(); svg.set('file', new File([Buffer.from('<svg onload=alert(1)>')], 'x.png', { type: 'image/png' }))
  assert.equal((await call('POST', '/api/uploads?kind=avatar', { cookie: me, form: svg })).status, 415)
})

test('image upload checks the bytes, not the name', async () => {
  resetRateLimits()
  const me = (await signIn()).cookie!
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')
  const fd = new FormData(); fd.set('file', new File([png], 'a.png', { type: 'image/png' }))
  const up = await call('POST', '/api/uploads', { cookie: me, form: fd })
  assert.equal(up.status, 200, JSON.stringify(up.body))
  assert.match(up.body.url, /^\/uploads\/.+\.png$/)
  const bad = new FormData(); bad.set('file', new File([Buffer.from('<svg onload=alert(1)>')], 'x.png', { type: 'image/png' }))
  assert.equal((await call('POST', '/api/uploads', { cookie: me, form: bad })).status, 415)
  const d = await call('POST', '/api/drops', { cookie: me, body: { text: '', image: up.body.url } })
  assert.equal(d.status, 201)
  assert.equal((await call('POST', '/api/drops', { cookie: me, body: { text: 'x', image: '/uploads/../../etc/passwd' } })).status, 400)
})

// ------------------------------------------------------------------ Privy, attester, smart accounts
const { setChainTransport } = await import('../src/chain')
const { custom, decodeFunctionData, encodeAbiParameters, keccak256: k256, toBytes: tb, verifyTypedData } = await import('viem')
const jose = await import('jose')

test('privy off by default: config says so and /api/auth/privy answers 501; wallet sign-in still works', async () => {
  delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET
  const cfg = await call('GET', '/api/auth/config')
  assert.deepEqual({ privy: cfg.body.privy, wallet: cfg.body.wallet }, { privy: false, wallet: true })
  assert.equal((await call('POST', '/api/auth/privy', { body: { identityToken: 'x'.repeat(40) } })).status, 501)
  assert.equal((await signIn()).status, 200)
})

test('privy: verified identity token signs in, reads the X id, rejects forged tokens; attester signs LinkHandle', async () => {
  resetRateLimits()
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true })
  process.env.PRIVY_APP_ID = 'test-app'
  process.env.PRIVY_APP_SECRET = 'test-only-not-a-secret'
  process.env.PRIVY_VERIFICATION_KEY = await jose.exportSPKI(publicKey)
  const smart = privateKeyToAccount(generatePrivateKey()).address
  const embedded = privateKeyToAccount(generatePrivateKey()).address
  const linked = JSON.stringify([
    { type: 'twitter_oauth', subject: '1234567890', username: 'marv_wif', name: 'Marv', pfp: null, lv: 1 },
    { type: 'wallet', wallet_client_type: 'privy', address: embedded, chain_type: 'ethereum', lv: 1 },
    { type: 'smart_wallet', address: smart, smart_wallet_type: 'kernel', lv: 1 },
  ])
  const mint = (key: CryptoKey, aud = 'test-app') => new jose.SignJWT({ linked_accounts: linked, cr: '1' })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' }).setIssuer('privy.io').setAudience(aud).setSubject('did:privy:test1')
    .setIssuedAt().setExpirationTime('1h').sign(key)

  assert.equal((await call('GET', '/api/auth/config')).body.privy, true)
  const other = await jose.generateKeyPair('ES256')
  assert.equal((await call('POST', '/api/auth/privy', { body: { identityToken: await mint(other.privateKey) } })).status, 401, 'wrong signer')
  assert.equal((await call('POST', '/api/auth/privy', { body: { identityToken: await mint(privateKey, 'other-app') } })).status, 401, 'wrong audience')

  const token = await mint(privateKey)
  const r = await call('POST', '/api/auth/privy', { body: { identityToken: token } })
  assert.equal(r.status, 200)
  assert.equal(r.body.me.handle, '', 'no made-up @name, even from X')
  assert.equal(r.body.me.needsHandle, true)
  assert.equal((await call('GET', '/api/onboarding', { cookie: r.cookie })).body.suggestedHandle, 'marv_wif', 'the X username is only a suggestion')
  assert.equal((await call('POST', '/api/drops', { body: { text: 'too early' }, cookie: r.cookie })).status, 403, 'no posting before a name')
  assert.equal((await call('POST', '/api/onboarding', { body: {}, cookie: r.cookie })).status, 400, 'onboarding needs the @name')
  const picked = await call('POST', '/api/onboarding', { body: { handle: 'marv_wif' }, cookie: r.cookie })
  assert.equal(picked.status, 200, JSON.stringify(picked.body))
  assert.equal(picked.body.me.handle, 'marv_wif')
  assert.equal(picked.body.me.onboarded, true)
  assert.equal(r.body.me.address, embedded.toLowerCase(), 'smart wallets are off: the embedded EVM wallet is the user’s address (a stray smart_wallet is ignored)')
  const again = await call('POST', '/api/auth/privy', { body: { identityToken: token } })
  assert.equal(again.body.me.handle, 'marv_wif', 'same Privy user, same account')
  assert.equal((await call('GET', '/api/x/resolve?handle=@Marv_Wif')).body.xUserId, '1234567890')

  // attester: off until configured
  delete process.env.ATTESTER_PRIVATE_KEY
  assert.equal((await call('POST', '/api/x/attest', { body: { identityToken: token }, cookie: r.cookie })).status, 503)
  // throwaway in-memory key, only for this test
  const attKey = generatePrivateKey(), att = privateKeyToAccount(attKey)
  const contract = privateKeyToAccount(generatePrivateKey()).address
  process.env.ATTESTER_PRIVATE_KEY = attKey
  process.env.WIFLY_CONTRACT_ADDRESS = contract
  const abi = [
    { type: 'function', name: 'handleNonce', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'attester', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  ] as const
  setChainTransport(custom({ async request({ method, params }: any) {
    if (method === 'eth_chainId') return '0x1237'
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
    const f = decodeFunctionData({ abi, data: params[0].data })
    return f.functionName === 'attester' ? encodeAbiParameters([{ type: 'address' }], [att.address]) : encodeAbiParameters([{ type: 'uint256' }], [3n])
  } }))
  const bad = await call('POST', '/api/x/attest', { body: { identityToken: token, account: privateKeyToAccount(generatePrivateKey()).address }, cookie: r.cookie })
  assert.equal(bad.status, 403, 'only the user’s own wallets')
  const a = await call('POST', '/api/x/attest', { body: { identityToken: token }, cookie: r.cookie })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  assert.equal(a.body.handleHash, k256(tb('x:1234567890')))
  assert.equal(a.body.account, embedded)
  assert.equal(a.body.nonce, '3')
  const ok = await verifyTypedData({
    address: att.address,
    domain: { name: 'Wifly', version: '1', chainId: 4663, verifyingContract: contract },
    types: { LinkHandle: [{ name: 'handleHash', type: 'bytes32' }, { name: 'account', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'LinkHandle',
    message: { handleHash: a.body.handleHash, account: embedded, nonce: 3n, deadline: BigInt(a.body.deadline) },
    signature: a.body.signature,
  })
  assert.ok(ok, 'signature recovers to the attester')
  setChainTransport(null)
  for (const k of ['PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'PRIVY_VERIFICATION_KEY', 'ATTESTER_PRIVATE_KEY', 'WIFLY_CONTRACT_ADDRESS']) delete process.env[k]
})

test('smart accounts: SIWE accepts an ERC-1271/6492 signature the chain vouches for, rejects one it does not', async () => {
  resetRateLimits()
  const smart = privateKeyToAccount(generatePrivateKey()).address // stands in for a contract wallet address
  const signer = privateKeyToAccount(generatePrivateKey())          // owner key; its signature does not recover to `smart`
  let valid = true
  setChainTransport(custom({ async request({ method }: any) {
    if (method === 'eth_chainId') return '0x1237'
    if (method === 'eth_call') return valid ? '0x0000000000000000000000000000000000000000000000000000000000000001' : '0x0000000000000000000000000000000000000000000000000000000000000000'
    if (method === 'eth_getCode') return '0x'
    throw new Error(`unexpected ${method}`)
  } }))
  const attempt = async () => {
    const { body: { nonce } } = await call('GET', '/api/auth/nonce')
    const message = createSiweMessage({ domain: 'localhost:5173', address: smart, statement: 'Sign in to Wifly. No transaction, no fee.', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
    return call('POST', '/api/auth/verify', { body: { message, signature: await signer.signMessage({ message }) } })
  }
  const yes = await attempt()
  assert.equal(yes.status, 200, JSON.stringify(yes.body))
  assert.equal(yes.body.me.address, smart.toLowerCase())
  valid = false
  assert.equal((await attempt()).status, 401)
  setChainTransport(null)
})

test('creators: public, capped by limit, only recent posters', async () => {
  const r = await call('GET', '/api/creators?limit=3')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.users))
  assert.ok(r.body.users.length <= 3)
  for (const u of r.body.users) { assert.ok(u.handle); assert.ok(u.drops >= 1) }
  const big = await call('GET', '/api/creators?limit=999')
  assert.ok(big.body.users.length <= 30)
})
