/** Your own name is never "taken", claims the app missed get recorded, failure logs, delete, admin, same-account sign-in. `npm test` */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, toBytes, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-s113-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET; delete process.env.ADMIN_ADDRESSES
const N = privateKeyToAccount(generatePrivateKey()).address
process.env.NAMES_CONTRACT_ADDRESS = N

const { app } = await import('../src/app')
const { migrate, db, run, one } = await import('../src/db')
const { resetRateLimits } = await import('../src/util')
const { setChainTransport } = await import('../src/chain')
const { verifyPending, backfillClaims } = await import('../src/verify')
const { setLogSink } = await import('../src/accounts')
const { setPrivyVerifierForTests } = await import('../src/privy')
const { cacheClear } = await import('../src/cache').then(m => ({ cacheClear: (m as any).clearAll ?? (m as any).cacheClear ?? (() => {}) }))

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
async function signInRaw(acct: PrivateKeyAccount, extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/auth/verify', { body: await siwe(acct, extra) })
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r
}
/** The account behind a session: null when the session no longer works, else the user id inside the cookie. */
const meId = async (cookie: string | undefined) => { if (!cookie) return null
  const r = await call('GET', '/api/me', { cookie }); if (!r.body?.me) return null
  return Number(JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[1], 'base64url').toString()).sub)
}

// ---- fake chain: ownerOfName / ownerOf / isAvailable / reverseName / theme, receipts and NameClaimed logs. Read-only.
const NAMES = parseAbi(['function ownerOf(uint256) view returns (address)', 'function theme(uint256) view returns (uint8)', 'function ownerOfName(string) view returns (address)',
  'function isAvailable(string) view returns (bool)', 'function reverseName(address) view returns (string)', 'function resolve(string) view returns (address)'])
const CLAIMED = parseAbi(['event NameClaimed(uint256 indexed tokenId, string name, address indexed owner, uint256 fee)'])
const owners = new Map<string, string>() // name → owner
const primaries = new Map<string, string>() // lowercase address → name.wif
const receipts = new Map<string, any[]>()
const claimLogs: { name: string; owner: string; block: number }[] = []
const h = (s: string) => keccak256(toBytes(s))
const tid = (n: string) => BigInt(h(n))
const nameByTid = (t: bigint) => [...owners.keys()].find(n => tid(n) === t)
const claimLog = (name: string, owner: string) => ({ address: N, topics: encodeEventTopics({ abi: CLAIMED, eventName: 'NameClaimed', args: { tokenId: tid(name), owner: owner as Hex } }) as Hex[],
  data: encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }], [name, 0n]) })
const pad = (n: number) => '0x' + n.toString(16)
const ZERO = '0x0000000000000000000000000000000000000000'
setChainTransport(custom({ async request({ method, params }: any) {
  if (method === 'eth_chainId') return '0x1237'
  if (method === 'eth_blockNumber') return pad(1000)
  if (method === 'eth_getLogs') {
    const f = Number(params[0].fromBlock), t = Number(params[0].toBlock)
    return claimLogs.filter(l => l.block >= f && l.block <= t).map((l, i) => ({ ...claimLog(l.name, l.owner), blockHash: h('b'), blockNumber: pad(l.block), transactionHash: h(`t${i}`), transactionIndex: '0x0', logIndex: pad(i), removed: false }))
  }
  if (method === 'eth_getTransactionReceipt') {
    const logs = receipts.get(String(params[0]).toLowerCase()); if (!logs) return null
    return { transactionHash: params[0], blockHash: h('b'), blockNumber: '0x1', transactionIndex: '0x0', from: N, to: N, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1',
      contractAddress: null, logsBloom: '0x' + '0'.repeat(512), type: '0x2', status: '0x1', logs: logs.map((l, i) => ({ ...l, blockHash: h('b'), blockNumber: '0x1', transactionHash: params[0], transactionIndex: '0x0', logIndex: pad(i), removed: false })) }
  }
  if (method === 'eth_call' && String(params[0].to).toLowerCase() === N.toLowerCase()) {
    const f = decodeFunctionData({ abi: NAMES, data: params[0].data })
    const addr = (a?: string) => encodeAbiParameters([{ type: 'address' }], [(a ?? ZERO) as Hex])
    switch (f.functionName) {
      case 'theme': return encodeAbiParameters([{ type: 'uint8' }], [0])
      case 'ownerOfName': return addr(owners.get(String(f.args[0])))
      case 'resolve': return addr(owners.get(String(f.args[0]).replace(/\.wif$/, '')))
      case 'isAvailable': return encodeAbiParameters([{ type: 'bool' }], [!owners.has(String(f.args[0]))])
      case 'reverseName': return encodeAbiParameters([{ type: 'string' }], [primaries.get(String(f.args[0]).toLowerCase()) ?? ''])
      case 'ownerOf': { const n = nameByTid(f.args[0] as bigint); if (!n) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' }); return addr(owners.get(n)) }
    }
  }
  throw new Error(`unexpected ${method}`)
} }))
/** A claim made onchain, outside the app (or that the app failed to record). */
function mint(name: string, owner: string, primary = true) {
  owners.set(name, owner); if (primary) primaries.set(owner.toLowerCase(), `${name}.wif`)
  claimLogs.push({ name, owner, block: 900 })
  const hash = h(`tx:${name}`).toLowerCase(); receipts.set(hash, [claimLog(name, owner)]); return hash
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const lines: string[] = []

before(async () => { await migrate(); setLogSink(l => lines.push(l)) })
after(() => { setLogSink(null); setPrivyVerifierForTests(null); setChainTransport(null); delete process.env.NAMES_CONTRACT_ADDRESS; delete process.env.ADMIN_ADDRESSES; db.close(); rmSync(dir, { recursive: true, force: true }) })

test('marv: a .wif minted by your own wallet but never recorded reads "yours" on @name, .wif and onboarding finishes', async () => {
  resetRateLimits()
  const marv = privateKeyToAccount(generatePrivateKey())
  const { cookie } = await signInRaw(marv)
  mint('marvpeggy', marv.address)
  // a stranger sees it as held by another wallet, with calm suggestions (no "_wif" tails)
  const anon = await call('GET', '/api/names/check?n=marvpeggy')
  assert.equal(anon.body.available, false); assert.equal(anon.body.reason, 'taken')
  assert.ok(anon.body.suggestions.length > 0 && anon.body.suggestions.every((s: string) => !s.endsWith('_wif')), JSON.stringify(anon.body.suggestions))
  // the owner: "yours", no suggestions, and the mirror is backfilled
  const w = await call('GET', '/api/names/check?n=marvpeggy', { cookie })
  assert.equal(w.body.reason, 'yours'); assert.deepEqual(w.body.suggestions, []); assert.match(w.body.message, /you own marvpeggy\.wif/)
  assert.ok(await one('SELECT 1 FROM names WHERE name = ? AND minted = 1', ['marvpeggy']))
  const hc = await call('GET', '/api/handles/check?h=marvpeggy', { cookie })
  assert.equal(hc.body.available, true, JSON.stringify(hc.body)); assert.equal(hc.body.reason, 'yours')
  // finishing onboarding with that @name works (this was the 409 "that handle is taken")
  const o = await call('POST', '/api/onboarding', { body: { handle: 'marvpeggy', name: 'marv' }, cookie })
  assert.equal(o.status, 200, JSON.stringify(o.body))
  const me = await call('GET', '/api/me', { cookie })
  assert.equal((me.body.me ?? me.body).handle, 'marvpeggy')
  assert.equal((await call('GET', '/api/users/marvpeggy')).status, 200)
})

test('own name with no mirror row: checkHandle/setHandle see the chain owner directly (a fresh session, before any .wif check)', async () => {
  resetRateLimits()
  const a = privateKeyToAccount(generatePrivateKey())
  const { cookie } = await signInRaw(a)
  mint('ownedfirst', a.address)
  const o = await call('POST', '/api/onboarding', { body: { handle: 'ownedfirst' }, cookie })
  assert.equal(o.status, 200, JSON.stringify(o.body))
  // someone else still can't take it
  const b = await signInRaw(privateKeyToAccount(generatePrivateKey()))
  assert.equal((await call('GET', '/api/handles/check?h=ownedfirst', { cookie: b.cookie })).body.available, false)
})

test('claim POST after the tx confirmed records the name (it used to answer 409 "that name isn\'t free")', async () => {
  resetRateLimits()
  const a = privateKeyToAccount(generatePrivateKey())
  const { cookie } = await signInRaw(a)
  assert.equal((await call('POST', '/api/onboarding', { body: { handle: 'claimer1' }, cookie })).status, 200)
  const hash = mint('claimer1x', a.address, false)
  const r = await call('POST', '/api/names/claim', { body: { name: 'claimer1x', txHash: hash, primary: true }, cookie })
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.pending, false)
  assert.equal(Number((await one<{ owner_id: number }>('SELECT owner_id FROM names WHERE name = ?', ['claimer1x']))?.owner_id), await meId(cookie))
})

test('a claim made with a wallet the account had not linked yet lands once it is linked (the privy wallet too)', async () => {
  resetRateLimits()
  const guest = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey())
  const { cookie } = await signInRaw(guest, { guest: true })
  const uid = await meId(cookie)
  const hash = mint('laterlinked', other.address)
  // a guest can't record it (link first), but the claim still lands once that wallet is linked
  const r = await call('POST', '/api/names/claim', { body: { name: 'laterlinked', txHash: hash }, cookie })
  assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'link_required')
  // a forged pending row never shows as theirs, and a stranger posting a tx without the event gets nothing
  const s = await signInRaw(privateKeyToAccount(generatePrivateKey()))
  const forged = await call('POST', '/api/names/claim', { body: { name: 'laterlinked', txHash: h('nope').toLowerCase() }, cookie: s.cookie })
  assert.equal(forged.status, 409)
  const l = await call('POST', '/api/auth/link/wallet', { body: await siwe(other), cookie })
  assert.equal(l.status, 200, JSON.stringify(l.body))
  const row = await one<{ owner_id: number; minted: number }>('SELECT owner_id, minted FROM names WHERE name = ?', ['laterlinked'])
  assert.equal(Number(row?.owner_id), uid); assert.equal(Number(row?.minted), 1)
})

test('the 60s sweep backfills onchain claims the db missed (from NameClaimed logs)', async () => {
  resetRateLimits()
  const a = privateKeyToAccount(generatePrivateKey())
  const { cookie } = await signInRaw(a)
  owners.set('sweptname', a.address); claimLogs.push({ name: 'sweptname', owner: a.address, block: 950 })
  await run("DELETE FROM kv WHERE k = 'names:cursor'")
  assert.equal(await one('SELECT 1 FROM names WHERE name = ?', ['sweptname']), undefined)
  assert.ok(await backfillClaims() >= 1)
  assert.equal(Number((await one<{ owner_id: number }>('SELECT owner_id FROM names WHERE name = ?', ['sweptname']))?.owner_id), await meId(cookie))
  // unknown wallets are left alone
  const x = privateKeyToAccount(generatePrivateKey()).address
  owners.set('strangers', x); claimLogs.push({ name: 'strangers', owner: x, block: 990 })
  await run("DELETE FROM kv WHERE k = 'names:cursor'"); await backfillClaims()
  assert.equal(await one('SELECT 1 FROM names WHERE name = ?', ['strangers']), undefined)
  await verifyPending() // and the sweep itself runs cleanly with the backfill inside
})

test('failed auth / me / onboarding / claim / link requests log one short line, never a token, cookie, signature or full wallet', async () => {
  resetRateLimits(); lines.length = 0
  const token = 'eyJhbGciOiJFUzI1NiJ9.SECRET-TOKEN-' + 'x'.repeat(40)
  setPrivyVerifierForTests(() => { throw Object.assign(new Error('identity token is not valid'), { status: 401 }) })
  const a = privateKeyToAccount(generatePrivateKey())
  const { cookie } = await signInRaw(a)
  await call('POST', '/api/auth/privy', { body: { identityToken: token } }).catch(() => null)
  await call('POST', '/api/auth/link/privy', { body: { identityToken: token }, cookie }).catch(() => null)
  const bad = await siwe(a); bad.signature = ('0x' + 'ab'.repeat(65)) as Hex
  await call('POST', '/api/auth/verify', { body: bad })
  await call('POST', '/api/onboarding', { body: { handle: 'x' }, cookie })
  await call('POST', '/api/names/claim', { body: { name: '!!' }, cookie })
  await call('GET', '/api/me/nothing-here', { cookie })
  setPrivyVerifierForTests(null)
  assert.ok(lines.filter(l => l.startsWith('[req-fail]')).length >= 4, lines.join('\n'))
  const all = lines.join('\n')
  for (const secret of [token, 'SECRET-TOKEN', cookie!.split('=')[1], bad.signature, a.address, a.address.toLowerCase(), a.address.slice(2, 12).toLowerCase()]) assert.ok(!all.includes(secret), `leaked ${secret.slice(0, 12)}`)
  for (const l of lines.filter(l => l.startsWith('[req-fail]'))) assert.match(l, /^\[req-fail\] (GET|POST|PATCH|DELETE) \/api\/\S+ \d{3} [a-z_0-9]+ u=([0-9a-f]{6}|-)$/)
})

test('delete my account: typed confirm, sessions revoked, @name freed, the wallet can start fresh, rate-limited', async () => {
  resetRateLimits()
  const a = privateKeyToAccount(generatePrivateKey())
  const { cookie } = await signInRaw(a)
  assert.equal((await call('POST', '/api/onboarding', { body: { handle: 'leaving1' }, cookie })).status, 200)
  const uid = await meId(cookie)
  assert.equal((await call('POST', '/api/me/delete', { body: { confirm: 'nope' }, cookie })).status, 400)
  const d = await call('POST', '/api/me/delete', { body: { confirm: '@leaving1' }, cookie })
  assert.equal(d.status, 200, JSON.stringify(d.body))
  assert.equal((await call('GET', '/api/me', { cookie })).body?.me ?? null, null) // old session is dead
  assert.equal((await call('GET', '/api/users/leaving1')).status, 404)
  assert.equal((await call('GET', '/api/handles/check?h=leaving1')).body.available, true)
  assert.ok(await one('SELECT 1 FROM deleted_users WHERE user_id = ?', [uid]))
  const again = await signInRaw(a)
  assert.notEqual(await meId(again.cookie!), uid)
  // rate limit: 3 per hour per account
  const b = await signInRaw(privateKeyToAccount(generatePrivateKey()))
  for (let i = 0; i < 3; i++) await call('POST', '/api/me/delete', { body: { confirm: 'wrong' }, cookie: b.cookie })
  assert.equal((await call('POST', '/api/me/delete', { body: { confirm: 'delete' }, cookie: b.cookie })).status, 429)
})

test('admin accounts page: 404 when ADMIN_ADDRESSES is empty or for non-admins; lists, masks emails, removes with a typed confirm, audits', async () => {
  resetRateLimits()
  const boss = privateKeyToAccount(generatePrivateKey()), joe = privateKeyToAccount(generatePrivateKey())
  const B = await signInRaw(boss), J = await signInRaw(joe)
  assert.equal((await call('POST', '/api/onboarding', { body: { handle: 'joe113' }, cookie: J.cookie })).status, 200)
  delete process.env.ADMIN_ADDRESSES
  assert.equal((await call('GET', '/api/admin/accounts', { cookie: B.cookie })).status, 404)
  process.env.ADMIN_ADDRESSES = ` ${boss.address} ,0xnotanaddress`
  assert.equal((await call('GET', '/api/admin/accounts', { cookie: J.cookie })).status, 404)
  assert.equal((await call('GET', '/api/admin/accounts')).status, 404)
  // an email account shows up masked
  setPrivyVerifierForTests(() => ({ did: 'did:privy:mail1', xUserId: null, xUsername: null, xName: null, email: 'someone.real@gmail.com', smartWallet: null, embeddedWallet: null, wallets: [] }))
  await call('POST', '/api/auth/privy', { body: { identityToken: 'x'.repeat(40) } })
  setPrivyVerifierForTests(null)
  const list = await call('GET', '/api/admin/accounts', { cookie: B.cookie })
  assert.equal(list.status, 200)
  const txt = JSON.stringify(list.body)
  assert.ok(!txt.includes('someone.real') && !txt.includes('gmail.com'), txt)
  const mail = list.body.accounts.find((r: any) => r.methods.includes('email'))
  assert.match(mail.email, /^s•••@g•••\.com$/); assert.equal(mail.handle, null); assert.equal(mail.onboarded, false)
  const unf = await call('GET', '/api/admin/accounts?filter=unfinished', { cookie: B.cookie })
  assert.ok(unf.body.accounts.every((r: any) => !r.onboarded))
  const jid = await meId(J.cookie!)
  assert.equal((await call('POST', `/api/admin/accounts/${jid}/remove`, { body: { confirm: 'joe' }, cookie: B.cookie })).status, 400)
  assert.equal((await call('POST', `/api/admin/accounts/${jid}/remove`, { body: { confirm: 'joe113' }, cookie: J.cookie })).status, 404)
  assert.equal((await call('POST', `/api/admin/accounts/${jid}/remove`, { body: { confirm: 'remove' }, cookie: B.cookie })).status, 200)
  assert.equal((await call('GET', '/api/users/joe113')).status, 404)
  assert.ok(await one("SELECT 1 FROM admin_audit WHERE action = 'remove_account' AND target_id = ?", [jid]))
  assert.ok(lines.some(l => l.startsWith('[admin] remove_account')))
  delete process.env.ADMIN_ADDRESSES
})

test('same account every time: sign up as guest, link a wallet, x and email, sign out, sign back in with each → same user', async () => {
  resetRateLimits()
  const guestKey = privateKeyToAccount(generatePrivateKey()), wallet = privateKeyToAccount(generatePrivateKey())
  const embedded = privateKeyToAccount(generatePrivateKey()).address.toLowerCase()
  const xId = { did: 'did:privy:loop1', xUserId: '4242', xUsername: 'loopy', xName: 'loopy', email: 'loop@proton.me', smartWallet: null, embeddedWallet: embedded, wallets: [embedded] }
  const g = await signInRaw(guestKey, { guest: true })
  const uid = await meId(g.cookie!)
  assert.equal((await call('POST', '/api/onboarding', { body: { handle: 'loopy' }, cookie: g.cookie })).status, 200)
  // link a wallet, then x + email (one privy login carries both, plus its embedded wallet)
  assert.equal((await call('POST', '/api/auth/link/wallet', { body: await siwe(wallet), cookie: g.cookie })).status, 200)
  setPrivyVerifierForTests(() => xId)
  const lx = await call('POST', '/api/auth/link/privy', { body: { identityToken: 'x'.repeat(40) }, cookie: g.cookie })
  assert.equal(lx.status, 200, JSON.stringify(lx.body))
  // the handle still checks as "that's you" everywhere while linked
  assert.equal((await call('GET', '/api/handles/check?h=loopy', { cookie: g.cookie })).body.reason, 'yours')
  await call('POST', '/api/auth/logout', { cookie: g.cookie })
  // back in with every method
  assert.equal(await meId((await signInRaw(guestKey, { guest: true })).cookie!), uid, 'guest key')
  assert.equal(await meId((await signInRaw(wallet)).cookie!), uid, 'wallet')
  const viaX = await call('POST', '/api/auth/privy', { body: { identityToken: 'x'.repeat(40) } })
  assert.equal(await meId(viaX.cookie!), uid, 'x')
  setPrivyVerifierForTests(() => ({ ...xId, xUserId: null, xUsername: null, xName: null })) // email-only token, same privy user
  assert.equal(await meId((await call('POST', '/api/auth/privy', { body: { identityToken: 'x'.repeat(40) } })).cookie!), uid, 'email')
  // the privy embedded wallet signing in directly (siwe) lands on the same account too
  setPrivyVerifierForTests(() => ({ ...xId, did: 'did:privy:other-device' }))
  assert.equal(await meId((await call('POST', '/api/auth/privy', { body: { identityToken: 'x'.repeat(40) } })).cookie!), uid, 'embedded wallet under a new did')
  setPrivyVerifierForTests(null)
})

test('linking x that was used once on its own (an empty sign-up) merges into this account instead of failing', async () => {
  resetRateLimits()
  const id = { did: 'did:privy:shell1', xUserId: '777', xUsername: 'shelly', xName: 'shelly', email: null, smartWallet: null, embeddedWallet: null, wallets: [] }
  setPrivyVerifierForTests(() => id)
  const shell = await call('POST', '/api/auth/privy', { body: { identityToken: 'x'.repeat(40) } })
  const shellId = await meId(shell.cookie!)
  const g = await signInRaw(privateKeyToAccount(generatePrivateKey()), { guest: true })
  assert.equal((await call('POST', '/api/onboarding', { body: { handle: 'shellmerge' }, cookie: g.cookie })).status, 200)
  const l = await call('POST', '/api/auth/link/privy', { body: { identityToken: 'x'.repeat(40) }, cookie: g.cookie })
  assert.equal(l.status, 200, JSON.stringify(l.body))
  const uid = await meId(g.cookie!)
  assert.notEqual(uid, shellId)
  assert.equal(await meId((await call('POST', '/api/auth/privy', { body: { identityToken: 'x'.repeat(40) } })).cookie!), uid)
  setPrivyVerifierForTests(null)
  void wait; void cacheClear
})

test('onboarding: claiming a different .wif as main name mid-flow, then finishing with the old @name, still finishes', async () => {
  resetRateLimits()
  const a = privateKeyToAccount(generatePrivateKey())
  const { cookie } = await signInRaw(a)
  const hash = mint('themidflow', a.address)
  const r = await call('POST', '/api/names/claim', { body: { name: 'themidflow', txHash: hash, primary: true }, cookie })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const o = await call('POST', '/api/onboarding', { body: { handle: 'midflow', name: 'mid' }, cookie })
  assert.equal(o.status, 200, JSON.stringify(o.body))
  assert.equal((await call('GET', '/api/me', { cookie })).body.me.handle, 'themidflow')
  assert.equal((await call('GET', '/api/me', { cookie })).body.me.onboarded, true)
})

test('landing featured post: real public post by id (default 88stVCX0GF), 404 when missing or locked so the card hides', async () => {
  resetRateLimits()
  const a = privateKeyToAccount(generatePrivateKey())
  const { cookie } = await signInRaw(a)
  assert.equal((await call('POST', '/api/onboarding', { body: { handle: 'featuredblue', name: 'BLUES' }, cookie })).status, 200)
  const uid = await meId(cookie)
  { const r0 = await call('GET', '/api/landing/featured'); assert.equal(r0.status, 200); assert.equal(r0.body.featured, null) }
  await run("INSERT INTO drops (id, author_id, text, like_count, created_at) VALUES ('88stVCX0GF', ?, 'first to be on WIFLY!', 2, ?)", [uid, Date.now()])
  const r = await call('GET', '/api/landing/featured')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.featured.id, '88stVCX0GF'); assert.equal(r.body.featured.text, 'first to be on WIFLY!')
  assert.equal(r.body.featured.author.handle, 'featuredblue'); assert.equal(r.body.featured.likes, 2); assert.equal(typeof r.body.featured.tipped, 'number')
  assert.equal(r.body.featured.author.address, undefined)
  await run("INSERT INTO drops (id, author_id, text, locked, created_at) VALUES ('lockedpost1', ?, 'paid', '{\"price\":50}', ?)", [uid, Date.now()])
  process.env.FEATURED_POST_ID = 'lockedpost1'
  { const r0 = await call('GET', '/api/landing/featured'); assert.equal(r0.status, 200); assert.equal(r0.body.featured, null) }
  delete process.env.FEATURED_POST_ID
  assert.equal((await call('POST', '/api/admin/landing', { body: { featured: 'lockedpost1' }, cookie })).status, 404)
})

const { reconcileAll, reconcileUser } = await import('../src/reconcile')
const { invalidate } = await import('../src/cache')
const { at } = await import('../../frontend/src/lib/format')
const bakCount = () => readdirSync(dir).filter(f => f.startsWith('wifly.db.bak-reconcile-')).length

test('reconcile: the @ass account whose wallet holds the .wif becomes that @name automatically, same account, posts kept; idempotent; one backup', async () => {
  resetRateLimits()
  const marv = privateKeyToAccount(generatePrivateKey())
  const first = await signInRaw(marv)
  const uid = (await meId(first.cookie))!
  // an onboarded account with an old @name on this wallet, its .wif minted by the same wallet, no mirror row
  await run(`UPDATE users SET handle = 'ass', name = 'ass', onboarded = 1, extras = '{"handlePicked":1}' WHERE id = ?`, [uid])
  await run("INSERT INTO drops (id, author_id, text, created_at) VALUES ('assdrop001', ?, 'old post', ?)", [uid, Date.now()])
  // (the first test in this file already uses one name, so this one mints another)
  mint('peggymarv', marv.address); await invalidate('rpc')
  const out = await reconcileAll({ url: process.env.DATABASE_URL, log: () => {} })
  assert.ok(out.some(r => r.uid === uid && r.action === 'renamed' && r.handle === 'peggymarv'), JSON.stringify(out))
  const u = (await one<any>('SELECT handle, name, extras, onboarded FROM users WHERE id = ?', [uid]))!
  assert.equal(u.handle, 'peggymarv'); assert.equal(u.name, 'peggymarv'); assert.equal(JSON.parse(u.extras).wifName, 'peggymarv')
  assert.ok(await one("SELECT 1 FROM drops WHERE id = 'assdrop001' AND author_id = ?", [uid]))
  assert.ok(await one("SELECT 1 FROM names WHERE name = 'peggymarv' AND owner_id = ? AND minted = 1", [uid]))
  // same session, same account; nothing shows ass
  const me = (await call('GET', '/api/me', { cookie: first.cookie })).body.me
  assert.equal(me.handle, 'peggymarv'); assert.equal(me.needsHandle, false)
  assert.equal((await call('GET', '/api/users/ass')).status, 404)
  assert.equal((await call('GET', '/api/handles/check?h=ass')).body.reason, 'reserved')
  // idempotent: again (boot, sweep, sign-in) changes nothing and takes no second backup
  const n = bakCount(); assert.equal(n, 1)
  assert.equal((await reconcileUser(uid, { url: process.env.DATABASE_URL, log: () => {} })).action, 'none')
  await reconcileAll({ url: process.env.DATABASE_URL, log: () => {} }); await verifyPending()
  resetRateLimits()
  const again = await signInRaw(marv)
  assert.equal(await meId(again.cookie), uid)
  assert.equal((await one<any>('SELECT handle FROM users WHERE id = ?', [uid]))!.handle, 'peggymarv')
  assert.equal(bakCount(), n)
  // the handle check never calls your own wallet's name "owned by another wallet"
  const hc = (await call('GET', '/api/handles/check?h=peggymarv', { cookie: again.cookie })).body
  assert.equal(hc.reason, 'yours'); assert.doesNotMatch(String(hc.message), /another wallet/)
})

test('reconcile: a guest whose wallet holds a .wif gets that @name on sign-in; a free holder of that @name goes back to the name step with a notice', async () => {
  resetRateLimits()
  const guest = privateKeyToAccount(generatePrivateKey())
  const g = await signInRaw(guest, { guest: true })
  const gid = (await meId(g.cookie))!
  assert.equal(JSON.parse((await one<any>('SELECT extras FROM users WHERE id = ?', [gid]))!.extras).guest, 1)
  // someone else picked @guestflat for free, without the .wif
  const other = privateKeyToAccount(generatePrivateKey())
  const o = await signInRaw(other)
  const oid = (await meId(o.cookie))!
  await run(`UPDATE users SET handle = 'guestflat', onboarded = 1, extras = '{"handlePicked":1}' WHERE id = ?`, [oid])
  mint('guestflat', guest.address); await invalidate('rpc')
  resetRateLimits()
  const g2 = await signInRaw(guest, { guest: true })
  assert.equal(await meId(g2.cookie), gid)
  const me = (await call('GET', '/api/me', { cookie: g2.cookie })).body.me
  assert.equal(me.handle, 'guestflat'); assert.equal(me.needsHandle, false)
  const om = (await call('GET', '/api/me', { cookie: o.cookie })).body.me
  assert.equal(om.needsHandle, true, 'the free holder picks a new @name')
  assert.equal(JSON.parse((await one<any>('SELECT extras FROM users WHERE id = ?', [oid]))!.extras).handleNotice, 'guestflat')
})

test('takeover only on ownerOfName read by the server: a forged claim, a stale mirror row or a client-sent tx never moves an @name', async () => {
  resetRateLimits()
  const eve = privateKeyToAccount(generatePrivateKey()), real = privateKeyToAccount(generatePrivateKey())
  const e = await signInRaw(eve)
  const eid = (await meId(e.cookie))!
  mint('realowned', real.address); await invalidate('rpc')
  // client claims a name it doesn't hold, with a made-up tx hash
  const claim = await call('POST', '/api/names/claim', { body: { name: 'realowned', txHash: '0x' + 'ab'.repeat(32) }, cookie: e.cookie })
  assert.notEqual(claim.status, 200)
  // a stale mirror row saying eve holds it is not enough either
  await run("INSERT OR REPLACE INTO names (name, owner_id, minted, created_at) VALUES ('realowned', ?, 1, ?)", [eid, Date.now()])
  await run(`UPDATE users SET extras = json_set(COALESCE(extras, '{}'), '$.guest', 1) WHERE id = ?`, [eid])
  const r = await reconcileUser(eid, { url: process.env.DATABASE_URL, log: () => {} })
  assert.notEqual(r.action, 'renamed')
  assert.notEqual((await one<any>('SELECT handle FROM users WHERE id = ?', [eid]))!.handle, 'realowned')
  assert.equal(await one("SELECT 1 FROM names WHERE name = 'realowned' AND owner_id = ?", [eid]), undefined, 'the stale row is dropped')
  assert.equal((await call('GET', '/api/handles/check?h=realowned', { cookie: e.cookie })).body.reason, 'wif-owned')
})

test('a .wif sold or sent away: the old holder keeps account and posts, the @name goes back to the name step and the pill goes (sign-in and sweep)', async () => {
  for (const via of ['sign-in', 'sweep'] as const) {
    resetRateLimits()
    const seller = privateKeyToAccount(generatePrivateKey()), buyer = privateKeyToAccount(generatePrivateKey())
    const label = via === 'sign-in' ? 'soldflat' : 'sentflat'
    const s = await signInRaw(seller)
    const sid = (await meId(s.cookie))!
    mint(label, seller.address); await invalidate('rpc')
    resetRateLimits(); await signInRaw(seller)
    assert.equal((await one<any>('SELECT handle FROM users WHERE id = ?', [sid]))!.handle, label)
    await run("INSERT INTO drops (id, author_id, text, created_at) VALUES (?, ?, 'kept', ?)", [`${label}d1`, sid, Date.now()])
    assert.equal((await call('GET', `/api/users/${label}`)).body.user.wifName, label)
    // transferred onchain
    owners.set(label, buyer.address); primaries.delete(seller.address.toLowerCase()); await invalidate('rpc')
    if (via === 'sign-in') { resetRateLimits(); await signInRaw(seller) } else await verifyPending()
    const u = (await one<any>('SELECT handle, extras, deleted_at FROM users WHERE id = ?', [sid]))!
    assert.ok(u.handle.startsWith('~'), `${via}: ${u.handle}`); assert.equal(u.deleted_at, null)
    assert.equal(JSON.parse(u.extras).wifName, undefined)
    assert.ok(await one('SELECT 1 FROM drops WHERE id = ? AND author_id = ?', [`${label}d1`, sid]))
    assert.equal((await call('GET', '/api/me', { cookie: s.cookie })).body.me.needsHandle, true)
    assert.equal(await one('SELECT 1 FROM names WHERE name = ? AND owner_id = ?', [label, sid]), undefined)
  }
})

test('display: the @username is always plain (@marvpeggy, never @marvpeggy.wif); the .wif rides separately as wifName for the profile pill', async () => {
  assert.equal(at('marvpeggy'), '@marvpeggy'); assert.equal(at('marvpeggy.wif'), '@marvpeggy'); assert.equal(at(''), '')
  const u = (await call('GET', '/api/users/peggymarv')).body.user
  assert.equal(u.handle, 'peggymarv'); assert.equal(u.wifName, 'peggymarv')
  assert.doesNotMatch(JSON.stringify(u), /@peggymarv\.wif/)
})

test('reserved names get no suggestions, and no suggestion ever contains a reserved word', async () => {
  resetRateLimits()
  const { hasReservedWord } = await import('../src/features')
  for (const q of ['ass', 'wifly', 'admin']) {
    assert.deepEqual((await call('GET', `/api/handles/check?h=${q}`)).body.suggestions, [], q)
    assert.deepEqual((await call('GET', `/api/names/check?n=${q}`)).body.suggestions, [], q)
  }
  for (const s of ['ass_wif', 'theass', 'assflat', 'realwifly', 'adminhq', 'the_admin', 'heywif', 'robinhoodflat']) assert.equal(hasReservedWord(s), true, s)
  for (const s of ['thebluehq', 'marvpeggy', 'realblue', 'flatearther']) assert.equal(hasReservedWord(s), false, s)
  // a taken plain name still gets clean twists
  const a = privateKeyToAccount(generatePrivateKey())
  const { cookie } = await signInRaw(a)
  assert.equal((await call('POST', '/api/onboarding', { body: { handle: 'bluesky' }, cookie })).status, 200)
  const t = await call('GET', '/api/handles/check?h=bluesky')
  assert.equal(t.body.reason, 'taken'); assert.ok(t.body.suggestions.length > 0 && t.body.suggestions.every((s: string) => !hasReservedWord(s)), JSON.stringify(t.body.suggestions))
})

