/** Plus paid onchain from any wallet on the account turns on the app's plus (check, me.plus, perks) right after the tx confirms. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-s1161p-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET; delete process.env.ADMIN_ADDRESSES
delete process.env.DCA_KEEPER_ENABLED; delete process.env.NAMES_CONTRACT_ADDRESS

const W = '0x1eeB081a4529A2905Ea888948185ADa66c0619F5', TEAM = '0x8E5f84738C0fb29670F370F73E53BD234CEfeF21'
process.env.WIFLY_CONTRACT_ADDRESS = W; process.env.PLUS_CREATOR_ADDRESS = TEAM
const { custom, decodeFunctionData, encodeFunctionResult, parseAbi } = await import('viem')
const { setChainTransport } = await import('../src/chain')
const { clearPlusSyncThrottle } = await import('../src/plusSync')
const { plusAccess, clearPlusGateCache } = await import('../src/plusGate')
const SUB = parseAbi(['function subStatus(address user, address creator) view returns (bool active, bool hasAccess, uint8 tier, uint64 expiry, uint256 graceEndsAt, uint8 plan)',
  'function autoRenewOf(address user, address creator) view returns (uint8 tier, uint8 plan, uint240 maxPrice)'])
const autos = new Map<string, bigint>()
// fake chain: subStatus by wallet, receipts by hash; `down` makes every read fail
const subs = new Map<string, { expiry: number; plan: 0 | 1 }>()
const receipts = new Map<string, { from: string; to: string; ok: boolean }>()
let down = false
const FAKE = custom({ async request({ method, params }: { method: string; params: any }) {
  if (down) throw new Error('rpc down')
  if (method === 'eth_chainId') return '0x1237'
  if (method === 'eth_call') {
    const { args, functionName } = decodeFunctionData({ abi: SUB, data: params[0].data })
    if (functionName === 'autoRenewOf') return encodeFunctionResult({ abi: SUB, functionName, result: [0, 0, autos.get(String(args[0]).toLowerCase()) ?? 0n] })
    const s = subs.get(String(args[0]).toLowerCase()); const t = Math.floor(Date.now() / 1000)
    const exp = s?.expiry ?? 0, grace = exp ? exp + 5 * 86400 : 0
    return encodeFunctionResult({ abi: SUB, functionName: 'subStatus', result: [exp > t, grace > t, 0, BigInt(exp), BigInt(grace), s?.plan ?? 0] })
  }
  if (method === 'eth_getTransactionReceipt') {
    const r = receipts.get(String(params[0]).toLowerCase()); if (!r) return null
    return { transactionHash: params[0], blockHash: '0x' + '1'.repeat(64), blockNumber: '0x10', from: r.from, to: r.to, status: r.ok ? '0x1' : '0x0', logs: [], gasUsed: '0x5208',
      cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', transactionIndex: '0x0', type: '0x2', contractAddress: null, logsBloom: '0x' + '0'.repeat(512) }
  }
  throw new Error('unexpected ' + method)
} })
setChainTransport(FAKE)
const fresh = () => { clearPlusSyncThrottle(); clearPlusGateCache() }
const DAY = 86400
const now = () => Math.floor(Date.now() / 1000)
const tx = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')

const { app } = await import('../src/app')
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

test('plus paid from a linked wallet shows on /api/me (check, me.plus) without any payment call', async () => {
  const a = key(), b = key()
  const c = await signIn(a); await onboard(c, 'plusmain')
  assert.equal((await linkWallet(c, b)).status, 200)
  fresh(); assert.equal((await me(c)).plus, false)
  subs.set(lc(b.address), { expiry: now() + 30 * DAY, plan: 0 })
  fresh(); const m = await me(c)
  assert.equal(m.plus, true, 'me.plus after a sub on the linked wallet')
  const pub = (await call('GET', '/api/users/plusmain')).body
  assert.equal((pub.user ?? pub).plus, true, 'the check shows to everyone')
  const v = (await call('GET', '/api/plus', { cookie: c })).body
  assert.equal(v.state, 'active'); assert.equal(v.plan, 'month')
  assert.equal(Math.round(v.expiresAt / 1000), subs.get(lc(b.address))!.expiry)
  clearPlusGateCache(); const uid = Number((await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', ['plusmain']))!.id)
  assert.equal((await plusAccess(uid, true)).ok, true, 'assistant / agent gate counts every wallet')
})

test('payment from the embedded wallet of an x account: verified, plus on in the same response', async () => {
  const e = key()
  const c = await privySignIn({ did: 'did:privy:plusx', xUserId: '777', xUsername: 'plusx', embeddedWallet: lc(e.address) })
  await onboard(c, 'plusxacct')
  fresh(); assert.equal((await me(c)).plus, false)
  subs.set(lc(e.address), { expiry: now() + 365 * DAY, plan: 1 })
  const h = tx(); receipts.set(h, { from: lc(e.address), to: lc(W), ok: true })
  resetRateLimits()
  const r = await call('POST', '/api/plus/payments', { body: { plan: 'year', kind: 'buy', txHash: h }, cookie: c })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.verified, true); assert.equal(r.body.pending, false)
  assert.equal(r.body.me.plus, true); assert.equal(r.body.plus.plan, 'year')
  assert.equal(Number((await one<{ verified: number }>('SELECT verified FROM plus_payments WHERE tx_hash = ?', [h]))!.verified), 1)
})

test('a receipt from someone else’s wallet is not verified; a sub on a stranger’s wallet never counts', async () => {
  const a = key(), stranger = key()
  const c = await signIn(a); await onboard(c, 'plusnope')
  subs.set(lc(stranger.address), { expiry: now() + 30 * DAY, plan: 0 })
  const h = tx(); receipts.set(h, { from: lc(stranger.address), to: lc(W), ok: true })
  resetRateLimits()
  const r = await call('POST', '/api/plus/payments', { body: { plan: 'month', txHash: h }, cookie: c })
  assert.equal(r.body.verified, false); assert.equal(r.body.pending, true); assert.equal(r.body.me.plus, false)
  const h2 = tx(); receipts.set(h2, { from: lc(a.address), to: lc(W), ok: false })
  resetRateLimits(); assert.equal((await call('POST', '/api/plus/payments', { body: { plan: 'month', txHash: h2 }, cookie: c })).body.verified, false, 'reverted tx')
})

test('a failed chain read never takes plus away; a clean read after expiry + grace does', async () => {
  const a = key()
  const c = await signIn(a); await onboard(c, 'plusend')
  subs.set(lc(a.address), { expiry: now() + 3 * DAY, plan: 0 })
  resetRateLimits(); assert.equal((await call('POST', '/api/plus/sync', { cookie: c })).body.me.plus, true)
  down = true
  try { fresh(); resetRateLimits(); const r = await call('POST', '/api/plus/sync', { cookie: c }); assert.equal(r.body.me.plus, true); assert.equal(r.body.ok, false) }
  finally { down = false }
  subs.set(lc(a.address), { expiry: now() - 6 * DAY, plan: 0 })
  fresh(); resetRateLimits(); assert.equal((await call('POST', '/api/plus/sync', { cookie: c })).body.me.plus, false)
  subs.set(lc(a.address), { expiry: now() - 2 * DAY, plan: 0 })
  fresh(); resetRateLimits(); const g = await call('POST', '/api/plus/sync', { cookie: c })
  assert.equal(g.body.me.plus, true, 'inside the 5 day grace the check stays'); assert.equal(g.body.plus.state, 'grace')
})

test('/api/me stays fast when the rpc hangs', async () => {
  const a = key()
  const c = await signIn(a); await onboard(c, 'plusslow')
  setChainTransport(custom({ request: () => new Promise(() => {}) }))
  try { fresh(); const t = Date.now(); const m = await me(c); assert.ok(m); assert.ok(Date.now() - t < 4000) }
  finally { setChainTransport(FAKE) }
})

test('auto-renew on a sub the mirror hadn’t seen yet: no “get plus first”, the chain decides; the holder wallet is named', async () => {
  const a = key(), paid = key()
  const c = await signIn(a); await onboard(c, 'plusauto')
  assert.equal((await linkWallet(c, paid)).status, 200)
  // like the live report: paid monthly from one wallet, setAutoRenew(1500) already went through onchain, the app mirror is empty
  subs.set(lc(paid.address), { expiry: now() + 30 * DAY, plan: 0 })
  autos.set(lc(paid.address), 1500n * 10n ** 18n)
  const uid = Number((await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', ['plusauto']))!.id)
  assert.equal(await one('SELECT 1 FROM plus_subs WHERE user_id = ?', [uid]), undefined)
  resetRateLimits()
  const r = await call('POST', '/api/plus/auto-renew', { body: { on: true, agreedPrice: 1500, plan: 'month' }, cookie: c })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.autoRenew, true); assert.equal(r.body.state, 'active')
  fresh(); const v = (await call('GET', '/api/plus', { cookie: c })).body
  assert.equal(v.wallet, lc(paid.address), 'the page knows which wallet must send setAutoRenew')
  assert.equal(v.autoRenew, true); assert.equal(v.agreedPrice, 1500)
  // turned off onchain → the mirror follows on the next sync
  autos.delete(lc(paid.address)); fresh(); resetRateLimits()
  assert.equal((await call('POST', '/api/plus/sync', { cookie: c })).body.plus.autoRenew, false)
  // no sub anywhere: still a clear 409
  const n = await signIn(key()); await onboard(n, 'plusnoauto'); resetRateLimits()
  const x = await call('POST', '/api/plus/auto-renew', { body: { on: true, agreedPrice: 1500 }, cookie: n })
  assert.equal(x.status, 409); assert.match(x.body.error, /get plus first/)
})
