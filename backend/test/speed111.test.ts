/** The pending verifier (tips, badge burns, .wif names read from receipts / ownerOf) and 'ass' reserved. `npm test` */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, parseEther, toBytes, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-s111-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET
const W = privateKeyToAccount(generatePrivateKey()).address
const B = privateKeyToAccount(generatePrivateKey()).address
const N = privateKeyToAccount(generatePrivateKey()).address

const { app } = await import('../src/app')
const { migrate, db, run, one, all } = await import('../src/db')
const { resetRateLimits } = await import('../src/util')
const { setChainTransport } = await import('../src/chain')
const { verifyPending } = await import('../src/verify')
const { RESERVED } = await import('../src/features')

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
async function signIn(acct: PrivateKeyAccount, handle: string) {
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'Sign in to Wifly. No transaction, no fee.', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const r = await call('POST', '/api/auth/verify', { body: { message, signature: await acct.signMessage({ message }) } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const o = await call('POST', '/api/onboarding', { body: { handle }, cookie: r.cookie })
  assert.equal(o.status, 200, JSON.stringify(o.body))
  return r.cookie!
}

// ---- a fake chain: receipts by hash, ownerOf by token id. Read-only calls only; anything else fails the test.
const receipts = new Map<string, { status: '0x1' | '0x0'; logs: { address: string; topics: Hex[]; data: Hex }[] }>()
const owners = new Map<bigint, string>()
const TIP = parseAbi(['event Tipped(address indexed from, address indexed creator, bytes32 indexed postId, uint256 amount, uint256 fee)'])
const BURN = parseAbi(['event BurnedForBadges(address indexed user, uint256 amount, uint256 totalBurnedByUser)'])
const NAMES = parseAbi(['function ownerOf(uint256) view returns (address)', 'function theme(uint256) view returns (uint8)'])
const h = (s: string) => keccak256(toBytes(s))
const tipLog = (from: string, creator: string, dropId: string, amt: number) => ({ address: W, topics: encodeEventTopics({ abi: TIP, eventName: 'Tipped', args: { from: from as Hex, creator: creator as Hex, postId: h(`post:${dropId}`) } }) as Hex[],
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [parseEther(String(amt)), parseEther(String(amt * 0.02))]) })
const burnLog = (user: string, amt: number) => ({ address: B, topics: encodeEventTopics({ abi: BURN, eventName: 'BurnedForBadges', args: { user: user as Hex } }) as Hex[],
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [parseEther(String(amt)), parseEther(String(amt))]) })
const pad = (n: number) => '0x' + n.toString(16)
setChainTransport(custom({ async request({ method, params }: any) {
  if (method === 'eth_chainId') return '0x1237'
  if (method === 'eth_getTransactionReceipt') {
    const r = receipts.get(String(params[0]).toLowerCase()); if (!r) return null
    return { transactionHash: params[0], blockHash: h('b'), blockNumber: '0x1', transactionIndex: '0x0', from: W, to: W, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1',
      contractAddress: null, logsBloom: '0x' + '0'.repeat(512), type: '0x2', status: r.status,
      logs: r.logs.map((l, i) => ({ ...l, blockHash: h('b'), blockNumber: '0x1', transactionHash: params[0], transactionIndex: '0x0', logIndex: pad(i), removed: false })) }
  }
  if (method === 'eth_call' && String(params[0].to).toLowerCase() === N.toLowerCase()) {
    const f = decodeFunctionData({ abi: NAMES, data: params[0].data })
    if (f.functionName === 'theme') return encodeAbiParameters([{ type: 'uint8' }], [1])
    const o = owners.get(f.args[0] as bigint); if (!o) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' })
    return encodeAbiParameters([{ type: 'address' }], [o as Hex])
  }
  throw new Error(`unexpected ${method}`)
} }))
const tx = (s: string) => h(`tx:${s}`).toLowerCase()

before(async () => { await migrate() })
after(() => { setChainTransport(null); for (const k of ['WIFLY_CONTRACT_ADDRESS', 'BADGES_CONTRACT_ADDRESS', 'NAMES_CONTRACT_ADDRESS']) delete process.env[k]; db.close(); rmSync(dir, { recursive: true, force: true }) })

test("'ass' is reserved: not a handle, not a .wif name", async () => {
  resetRateLimits()
  assert.ok(RESERVED.has('ass'))
  assert.equal((await call('GET', '/api/handles/check?h=ass')).body.available, false)
  assert.equal((await call('GET', '/api/handles/check?h=ASS')).body.available, false)
  assert.equal((await call('GET', '/api/names/check?n=ass')).body.available, false)
  const c = await signIn(privateKeyToAccount(generatePrivateKey()), 'notass1')
  const r = await call('POST', '/api/onboarding', { body: { handle: 'ass' }, cookie: c })
  assert.notEqual(r.status, 200)
})

test('tips: verified only when the Tipped event matches tipper, creator, post and amount; then tip_total moves', async () => {
  resetRateLimits()
  process.env.WIFLY_CONTRACT_ADDRESS = W
  const creator = privateKeyToAccount(generatePrivateKey()), fan = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey())
  const cc = await signIn(creator, 'tipcreator'), fc = await signIn(fan, 'tipfan')
  const d = await call('POST', '/api/drops', { body: { text: 'tip me' }, cookie: cc })
  assert.ok(d.status < 300, JSON.stringify(d.body))
  const dropId = String((await one<{ id: string }>('SELECT id FROM drops ORDER BY created_at DESC LIMIT 1'))!.id)
  const total = async () => Number((await one<{ t: number }>('SELECT tip_total AS t FROM drops WHERE id = ?', [dropId]))!.t)

  receipts.set(tx('wrongfrom'), { status: '0x1', logs: [tipLog(other.address, creator.address, dropId, 50)] })
  receipts.set(tx('wrongamt'), { status: '0x1', logs: [tipLog(fan.address, creator.address, dropId, 49)] })
  receipts.set(tx('reverted'), { status: '0x0', logs: [tipLog(fan.address, creator.address, dropId, 50)] })
  for (const k of ['wrongfrom', 'wrongamt', 'reverted', 'notmined']) {
    const r = await call('POST', `/api/drops/${dropId}/tips`, { body: { amount: 50, txHash: tx(k) }, cookie: fc })
    assert.equal(r.status, 200); assert.equal(r.body.verified, false, k)
  }
  assert.equal(await total(), 0, 'nothing unverified counts')

  receipts.set(tx('good'), { status: '0x1', logs: [tipLog(fan.address, creator.address, dropId, 50)] })
  const ok = await call('POST', `/api/drops/${dropId}/tips`, { body: { amount: 50, txHash: tx('good') }, cookie: fc })
  assert.equal(ok.body.verified, true)
  assert.equal(await total(), 50)
  const again = await call('POST', `/api/drops/${dropId}/tips`, { body: { amount: 50, txHash: tx('good') }, cookie: fc })
  assert.equal(again.body.verified, false, 'a tx hash counts once')
  assert.equal(await total(), 50)

  // mined later: the sweep picks it up
  receipts.set(tx('notmined'), { status: '0x1', logs: [tipLog(fan.address, creator.address, dropId, 50)] })
  await verifyPending()
  assert.equal(await total(), 100)
  delete process.env.WIFLY_CONTRACT_ADDRESS
})

test('badge burns: counted from the BurnedForBadges event (chain amount), not the client', async () => {
  resetRateLimits()
  process.env.BADGES_CONTRACT_ADDRESS = B
  const a = privateKeyToAccount(generatePrivateKey()), x = privateKeyToAccount(generatePrivateKey())
  const c = await signIn(a, 'burner1')
  const uid = Number((await one<{ id: number }>('SELECT id FROM users WHERE address = ?', [a.address.toLowerCase()]))!.id)
  receipts.set(tx('burn-other'), { status: '0x1', logs: [burnLog(x.address, 5000)] })
  assert.equal((await call('POST', '/api/badges/burns', { body: { amount: 5000, txHash: tx('burn-other') }, cookie: c })).body.verified, false)
  receipts.set(tx('burn'), { status: '0x1', logs: [burnLog(a.address, 1000)] })
  const r = await call('POST', '/api/badges/burns', { body: { amount: 999999, txHash: tx('burn') }, cookie: c })
  assert.equal(r.body.verified, true)
  const s = await one<{ s: number }>('SELECT SUM(amount) AS s FROM badge_burns WHERE user_id = ? AND verified = 1', [uid])
  assert.equal(Number(s!.s), 1000, 'the chain amount wins')
  delete process.env.BADGES_CONTRACT_ADDRESS
})

test('.wif claim: minted flips once ownerOf agrees; an unknown owner never resets the mirror automatically', async () => {
  resetRateLimits()
  process.env.NAMES_CONTRACT_ADDRESS = N
  const a = privateKeyToAccount(generatePrivateKey())
  const c = await signIn(a, 'claimer1')
  const id = (n: string) => BigInt(h(n))
  const r = await call('POST', '/api/names/claim', { body: { name: 'flatearth', txHash: tx('claim') }, cookie: c })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const minted = async (n: string) => Number((await one<{ m: number }>('SELECT minted AS m FROM names WHERE name = ?', [n]))?.m ?? -1)
  assert.equal(await minted('flatearth'), 0, 'not on chain yet')
  owners.set(id('flatearth'), privateKeyToAccount(generatePrivateKey()).address)
  await verifyPending()
  assert.equal(await minted('flatearth'), 0, 'stranger owner: left alone')
  owners.set(id('flatearth'), a.address)
  await verifyPending()
  assert.equal(await minted('flatearth'), 1)
  delete process.env.NAMES_CONTRACT_ADDRESS
})

// ---- once-only verification
async function tipSetup(tag: string) {
  resetRateLimits()
  process.env.WIFLY_CONTRACT_ADDRESS = W
  const creator = privateKeyToAccount(generatePrivateKey()), fan = privateKeyToAccount(generatePrivateKey())
  const cc = await signIn(creator, `cr${tag}`), fc = await signIn(fan, `fa${tag}`)
  await call('POST', '/api/drops', { body: { text: `drop ${tag}` }, cookie: cc })
  const dropId = String((await one<{ id: string }>('SELECT id FROM drops ORDER BY created_at DESC, rowid DESC LIMIT 1'))!.id)
  const total = async () => Number((await one<{ t: number }>('SELECT tip_total AS t FROM drops WHERE id = ?', [dropId]))!.t)
  const verifiedRows = async (hash: string) => Number((await one<{ n: number }>('SELECT COUNT(*) AS n FROM tips WHERE lower(tx_hash) = ? AND verified = 1', [hash.toLowerCase()]))!.n)
  const tip = (hash: string) => call('POST', `/api/drops/${dropId}/tips`, { body: { amount: 50, txHash: hash }, cookie: fc })
  return { creator, fan, dropId, total, verifiedRows, tip }
}

test('tips: concurrent double POSTs of the same hash count once', async () => {
  const s = await tipSetup('dbl')
  receipts.set(tx('dbl'), { status: '0x1', logs: [tipLog(s.fan.address, s.creator.address, s.dropId, 50)] })
  const rs = await Promise.all([s.tip(tx('dbl')), s.tip(tx('dbl')), s.tip(tx('dbl'))])
  assert.equal(rs.filter(r => r.body.verified).length, 1)
  assert.equal(await s.total(), 50)
  assert.equal(await s.verifiedRows(tx('dbl')), 1)
  delete process.env.WIFLY_CONTRACT_ADDRESS
})

test('tips: a POST racing the sweep counts once', async () => {
  const s = await tipSetup('race')
  await s.tip(tx('race')) // not mined yet: pending
  receipts.set(tx('race'), { status: '0x1', logs: [tipLog(s.fan.address, s.creator.address, s.dropId, 50)] })
  await Promise.all([s.tip(tx('race')), verifyPending(), verifyPending()])
  await verifyPending()
  assert.equal(await s.total(), 50)
  assert.equal(await s.verifiedRows(tx('race')), 1)
  delete process.env.WIFLY_CONTRACT_ADDRESS
})

test('tips: a mixed-case hash is stored lowercase and is the same hash', async () => {
  const s = await tipSetup('mix')
  receipts.set(tx('mix'), { status: '0x1', logs: [tipLog(s.fan.address, s.creator.address, s.dropId, 50)] })
  const upper = '0x' + tx('mix').slice(2).toUpperCase()
  assert.equal((await s.tip(upper)).body.verified, true)
  assert.equal((await s.tip(tx('mix'))).body.verified, false)
  assert.equal((await s.tip(upper)).body.verified, false)
  assert.equal(await s.total(), 50)
  const stored = await one<{ n: number }>('SELECT COUNT(*) AS n FROM tips WHERE tx_hash <> lower(tx_hash)')
  assert.equal(Number(stored!.n), 0)
  // a resend by the same tipper is the same tip (one row); the database itself still refuses a second verified row for one hash
  assert.equal(Number((await one<{ n: number }>('SELECT COUNT(*) AS n FROM tips WHERE tx_hash = ?', [tx('mix')]))!.n), 1)
  await run('INSERT INTO tips (from_id, to_id, drop_id, amount, tx_hash, verified, created_at) VALUES (1, 2, NULL, 50, ?, 0, ?)', [tx('mix'), Date.now()])
  const row = (await one<{ id: number }>('SELECT id FROM tips WHERE tx_hash = ? AND verified = 0 LIMIT 1', [tx('mix')]))!
  await assert.rejects(run('UPDATE tips SET verified = 1 WHERE id = ?', [row.id]))
  delete process.env.WIFLY_CONTRACT_ADDRESS
})

test('burns: front-running a hash credits nobody but the wallet owner, who can still claim it later', async () => {
  resetRateLimits()
  process.env.BADGES_CONTRACT_ADDRESS = B
  const thief = privateKeyToAccount(generatePrivateKey()), owner = privateKeyToAccount(generatePrivateKey())
  const tc = await signIn(thief, 'thief1')
  const sum = async (addr: string) => Number((await one<{ s: number }>(`SELECT COALESCE(SUM(b.amount), 0) AS s FROM badge_burns b JOIN users u ON u.id = b.user_id
    WHERE u.address = ? AND b.verified = 1`, [addr.toLowerCase()]))!.s)
  receipts.set(tx('owned-burn'), { status: '0x1', logs: [burnLog(owner.address, 10000)] })
  assert.equal((await call('POST', '/api/badges/burns', { body: { amount: 10000, txHash: tx('owned-burn') }, cookie: tc })).body.verified, false, 'owner not here yet: nobody gets it')
  await verifyPending()
  assert.equal(await sum(thief.address), 0)
  const oc = await signIn(owner, 'owner1')
  assert.equal((await call('POST', '/api/badges/burns', { body: { amount: 10000, txHash: '0x' + tx('owned-burn').slice(2).toUpperCase() }, cookie: oc })).body.verified, true)
  assert.equal(await sum(owner.address), 10000)
  assert.equal(await sum(thief.address), 0)
  // owner already signed up: a thief posting first still credits the owner
  receipts.set(tx('owned-burn-2'), { status: '0x1', logs: [burnLog(owner.address, 1000)] })
  await call('POST', '/api/badges/burns', { body: { amount: 1000, txHash: tx('owned-burn-2') }, cookie: tc })
  assert.equal(await sum(owner.address), 11000)
  assert.equal(await sum(thief.address), 0)
  delete process.env.BADGES_CONTRACT_ADDRESS
})

test('sweeps never overlap', async () => {
  process.env.WIFLY_CONTRACT_ADDRESS = W
  const [a, b] = await Promise.all([verifyPending(), verifyPending()])
  assert.ok(a === 0 || b === 0)
  delete process.env.WIFLY_CONTRACT_ADDRESS
})

test('migration: old mixed-case tip hashes are lowercased and a double-verified hash keeps only its oldest row', async () => {
  await run('DROP INDEX IF EXISTS tips_tx_verified')
  const H = '0x' + tx('legacy').slice(2).toUpperCase()
  await run('INSERT INTO tips (from_id, to_id, drop_id, amount, tx_hash, verified, created_at) VALUES (1, 2, NULL, 5, ?, 1, 1), (1, 2, NULL, 5, ?, 1, 2)', [H, tx('legacy')])
  await migrate()
  const rows = await all<{ tx_hash: string; verified: number }>('SELECT tx_hash, verified FROM tips WHERE lower(tx_hash) = ? ORDER BY id', [tx('legacy')])
  assert.deepEqual(rows.map(r => [r.tx_hash, Number(r.verified)]), [[tx('legacy'), 1], [tx('legacy'), 0]])
  assert.ok(await one("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'tips_tx_verified'"))
})
