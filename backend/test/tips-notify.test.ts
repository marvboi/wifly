/** Tips with no post (profile / tip sheet) record a tip; "tipped you" goes out only once the tip is proven onchain, once per tx;
 *  the onchain sweep records tips the app missed (deduped by tx hash + receiver); admins can see which account owns a wallet. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-tips-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET; delete process.env.ADMIN_ADDRESSES
delete process.env.DCA_KEEPER_ENABLED; delete process.env.NAMES_CONTRACT_ADDRESS; delete process.env.TIP_FEE_BPS
const W = '0x1eeB081a4529A2905Ea888948185ADa66c0619F5'
process.env.WIFLY_CONTRACT_ADDRESS = W
process.env.TIPS_BACKFILL_BLOCKS = '1000'

const { custom, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, parseEther, toBytes } = await import('viem')
const { setChainTransport } = await import('../src/chain')
const EV = parseAbi(['event Tipped(address indexed from, address indexed creator, bytes32 indexed postId, uint256 amount, uint256 fee)'])
type Log = { from: string; creator: string; postId?: string; amount: bigint; fee: bigint; hash: string; block: number }
const logs: Log[] = []
/** mined receipts by tx hash (anything else is "not mined yet") */
const receipts = new Map<string, { status?: 'success' | 'reverted'; logs: Omit<Log, 'hash' | 'block'>[] }>()
const evLog = (l: Omit<Log, 'hash' | 'block'>, hash: string, block: number, i: number) => ({
  address: W.toLowerCase(), blockNumber: hex(block), blockHash: '0x' + '3'.repeat(64), transactionHash: hash, transactionIndex: '0x0', logIndex: hex(i), removed: false,
  topics: encodeEventTopics({ abi: EV, eventName: 'Tipped', args: { from: l.from as `0x${string}`, creator: l.creator as `0x${string}`, postId: (l.postId ?? '0x' + '0'.repeat(64)) as `0x${string}` } }),
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [l.amount, l.fee]),
})
let head = 5000
const hex = (n: number) => '0x' + n.toString(16)
const FAKE = custom({ async request({ method, params }: { method: string; params: any }) {
  if (method === 'eth_chainId') return '0x1237'
  if (method === 'eth_blockNumber') return hex(head)
  if (method === 'eth_getTransactionReceipt') {
    const r = receipts.get(String(params[0]).toLowerCase()); if (!r) return null // not mined yet: client-recorded rows stay pending
    return { transactionHash: params[0], transactionIndex: '0x0', blockHash: '0x' + '3'.repeat(64), blockNumber: hex(head), from: r.logs[0]?.from ?? W, to: W, cumulativeGasUsed: '0x1', gasUsed: '0x1',
      effectiveGasPrice: '0x1', contractAddress: null, logsBloom: '0x' + '0'.repeat(512), type: '0x2', status: r.status === 'reverted' ? '0x0' : '0x1', logs: r.logs.map((l, i) => evLog(l, params[0], head, i)) }
  }
  if (method === 'eth_getBlockByNumber') return { number: params[0], timestamp: hex(Math.floor(Date.now() / 1000) - 60), hash: '0x' + '2'.repeat(64), parentHash: '0x' + '0'.repeat(64), transactions: [], logsBloom: '0x' + '0'.repeat(512), gasLimit: '0x1', gasUsed: '0x0', miner: '0x' + '0'.repeat(40), extraData: '0x', difficulty: '0x0', nonce: '0x0000000000000000', size: '0x1', stateRoot: '0x' + '0'.repeat(64), receiptsRoot: '0x' + '0'.repeat(64), transactionsRoot: '0x' + '0'.repeat(64), sha3Uncles: '0x' + '0'.repeat(64), uncles: [] }
  if (method === 'eth_getLogs') {
    const f = params[0], lo = Number(BigInt(f.fromBlock)), hi = Number(BigInt(f.toBlock))
    return logs.filter(l => l.block >= lo && l.block <= hi).map((l, i) => evLog(l, l.hash, l.block, i))
  }
  if (method === 'eth_call') throw new Error('no calls here')
  throw new Error('unexpected ' + method)
} })
setChainTransport(FAKE)

const { app } = await import('../src/app')
const { migrate, one, all } = await import('../src/db')
const { resetRateLimits } = await import('../src/util')
const { backfillTips, verifyTip, verifyPending } = await import('../src/verify')
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
async function signIn(acct: PrivateKeyAccount) {
  resetRateLimits()
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'Sign in to Wifly. No transaction, no fee.', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const r = await call('POST', '/api/auth/verify', { body: { message, signature: await acct.signMessage({ message }) } })
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.cookie!
}
const onboard = async (cookie: string, handle: string) => assert.equal((await call('POST', '/api/onboarding', { body: { handle }, cookie })).status, 200)
const tx = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')
const notifs = async (cookie: string) => ((await call('GET', '/api/notifications', { cookie })).body.items as any[]).filter(n => n.kind === 'tip')
const uidOf = async (h: string) => Number((await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', [h]))!.id)

const A = key(), B = key(), C = key(), STRANGER = key()
let ca = '', cb = '', cc = ''
test('setup', async () => {
  ca = await signIn(A); await onboard(ca, 'tipsender')
  cb = await signIn(B); await onboard(cb, 'tipreceiver')
  cc = await signIn(C); await onboard(cc, 'tipadmin')
})

test('a profile / tip sheet tip (no post, no chat) records a pending tip and sends nothing until it is proven onchain', async () => {
  resetRateLimits()
  const h = tx()
  const r = await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 100, txHash: h }, cookie: ca })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.verified, false)
  const row = await one<any>('SELECT * FROM tips WHERE tx_hash = ?', [h])
  assert.ok(row); assert.equal(row.drop_id, null); assert.equal(Number(row.to_id), await uidOf('tipreceiver')); assert.equal(Number(row.amount), 100)
  assert.equal(Number(row.verified), 0)
  assert.equal((await notifs(cb)).length, 0, 'no "tipped you" for an unverified tip')
  // sent twice (a retry): still one row, still nothing
  resetRateLimits()
  assert.equal((await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 100, txHash: h }, cookie: ca })).body.already, true)
  assert.equal((await all('SELECT id FROM tips WHERE tx_hash = ?', [h])).length, 1)
  assert.equal((await notifs(cb)).length, 0)
})

test('one verified tip sends exactly one notification (client call, verifier sweep and retries together)', async () => {
  resetRateLimits()
  const before = (await notifs(cb)).length
  const h = tx()
  receipts.set(h, { logs: [{ from: A.address, creator: B.address, amount: parseEther('100'), fee: parseEther('2') }] })
  const r = await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 100, txHash: h }, cookie: ca })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.verified, true)
  const ns = await notifs(cb)
  assert.equal(ns.length, before + 1)
  const n = ns[0]
  assert.equal(n.drop, null); assert.equal(n.meta.amount, 98); assert.equal(n.meta.gross, 100); assert.equal(n.actors[0].handle, 'tipsender')
  // the earlier unmined tip is mined now: the sweep verifies it and sends its one notification
  const pending = await one<any>('SELECT id, tx_hash FROM tips WHERE verified = 0 AND amount = 100 AND tx_hash IS NOT NULL ORDER BY id LIMIT 1')
  receipts.set(pending.tx_hash, { logs: [{ from: A.address, creator: B.address, amount: parseEther('100'), fee: parseEther('2') }] })
  await verifyPending()
  assert.equal((await notifs(cb)).length, before + 2)
  // everything again: retries, re-verify, the sweep, the log sweep over the same blocks
  resetRateLimits()
  assert.equal((await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 100, txHash: h }, cookie: ca })).body.already, true)
  assert.equal(await verifyTip(Number((await one<any>('SELECT id FROM tips WHERE tx_hash = ?', [h])).id)), false)
  await verifyPending()
  head += 100
  logs.push({ from: A.address, creator: B.address, amount: parseEther('100'), fee: parseEther('2'), hash: h, block: head - 50 })
  assert.equal(await backfillTips(), 0)
  assert.equal((await notifs(cb)).length, before + 2)
  assert.equal(Number((await one<any>("SELECT COUNT(*) AS n FROM notifications WHERE dkey = ?", ['tip:' + h])).n), 1)
})

test('an unverified or fake tip sends no notification: wrong amount, someone else\'s tx, reverted, no hash', async () => {
  resetRateLimits()
  const before = (await notifs(cb)).length
  const bid = await uidOf('tipreceiver')
  // claims 1,000,000 WIF; the receipt shows 1
  const fake = tx()
  receipts.set(fake, { logs: [{ from: A.address, creator: B.address, amount: parseEther('1'), fee: 0n }] })
  const r1 = await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 1_000_000, txHash: fake }, cookie: ca })
  assert.equal(r1.status, 200); assert.equal(r1.body.verified, false)
  // a real tx hash, but the tip in it was from a stranger (C claims it)
  const theirs = tx()
  receipts.set(theirs, { logs: [{ from: STRANGER.address, creator: B.address, amount: parseEther('5'), fee: 0n }] })
  resetRateLimits()
  assert.equal((await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 5, txHash: theirs }, cookie: cc })).body.verified, false)
  // reverted
  const rev = tx()
  receipts.set(rev, { status: 'reverted', logs: [] })
  resetRateLimits()
  assert.equal((await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 7, txHash: rev }, cookie: ca })).body.verified, false)
  // in a chat: a fake amount drops a pending bubble and nothing else
  const dmFake = tx()
  receipts.set(dmFake, { logs: [{ from: A.address, creator: B.address, amount: parseEther('2'), fee: 0n }] })
  resetRateLimits()
  const d = await call('POST', '/api/dms/tipreceiver/tip', { body: { amount: 999_999, txHash: dmFake }, cookie: ca })
  assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.verified, false)
  // no tx hash at all (profile and drop): recorded as a preview, never notifies
  resetRateLimits()
  assert.equal((await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 500 }, cookie: ca })).status, 200)
  const dr = await call('POST', '/api/drops', { body: { text: 'a drop for a preview tip' }, cookie: cb })
  resetRateLimits()
  assert.equal((await call('POST', `/api/drops/${String(dr.body.drop?.id ?? dr.body.id)}/tips`, { body: { amount: 500 }, cookie: ca })).status, 200)
  await verifyPending()
  assert.equal((await notifs(cb)).length, before, 'no notification for any of them')
  assert.equal(await one("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'tip' AND json_extract(meta, '$.gross') IN (1000000, 999999, 500, 7)", [bid]), undefined)
  for (const h of [fake, rev, dmFake]) assert.equal(Number((await one<any>('SELECT verified FROM tips WHERE tx_hash = ?', [h])).verified), 0)
})

test('a verified chat tip notifies once, marked as a chat tip', async () => {
  resetRateLimits()
  const before = (await notifs(cb)).length
  const h = tx()
  receipts.set(h, { logs: [{ from: A.address, creator: B.address, amount: parseEther('8'), fee: parseEther('0.16') }] })
  const d = await call('POST', '/api/dms/tipreceiver/tip', { body: { amount: 8, txHash: h }, cookie: ca })
  assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.verified, true)
  const ns = await notifs(cb)
  assert.equal(ns.length, before + 1); assert.equal(ns[0].meta.dm, true); assert.equal(ns[0].meta.amount, 7.84)
  assert.equal((await call('POST', '/api/dms/tipreceiver/tip', { body: { amount: 8, txHash: h }, cookie: ca })).status, 409)
  await verifyPending()
  assert.equal((await notifs(cb)).length, before + 1)
})

test('a tip from a wallet no account owns sends one notification, even when the app filed the hash first', async () => {
  resetRateLimits()
  const before = (await notifs(cb)).length
  // the sender paid from an outside wallet but recorded it in the app: the app row can't be verified as theirs
  const h = tx()
  receipts.set(h, { logs: [{ from: STRANGER.address, creator: B.address, amount: parseEther('12'), fee: parseEther('0.24') }] })
  assert.equal((await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 12, txHash: h }, cookie: ca })).body.verified, false)
  assert.equal((await notifs(cb)).length, before)
  head += 100
  logs.push({ from: STRANGER.address, creator: B.address, amount: parseEther('12'), fee: parseEther('0.24'), hash: h, block: head - 5 })
  // and one the app never saw
  const h2 = tx()
  logs.push({ from: STRANGER.address, creator: B.address, amount: parseEther('6'), fee: 0n, hash: h2, block: head - 4 })
  assert.equal(await backfillTips(), 2)
  const ns = await notifs(cb)
  assert.equal(ns.length, before + 2)
  for (const g of [12, 6]) {
    const n = ns.filter(x => x.meta.gross === g); assert.equal(n.length, 1, `one for ${g}`)
    assert.equal(n[0].actors.length, 0); assert.match(n[0].meta.from, /^0x[0-9a-f]{4}…[0-9a-f]{4}$/)
  }
  // settled in place: one row, the sender from the log (nobody), verified
  const rows = await all<any>('SELECT * FROM tips WHERE tx_hash = ?', [h])
  assert.equal(rows.length, 1); assert.equal(Number(rows[0].verified), 1); assert.equal(Number(rows[0].from_id), 0)
  // again: the sweep over the same blocks, the verifier, a retry
  await one("UPDATE kv SET v = '0' WHERE k = 'tips:cursor'")
  assert.equal(await backfillTips(), 0)
  await verifyPending()
  resetRateLimits()
  await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 12, txHash: h }, cookie: ca })
  assert.equal((await notifs(cb)).length, before + 2)
})

test('profile tips: guards', async () => {
  resetRateLimits()
  assert.equal((await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 5 } })).status, 401)
  assert.equal((await call('POST', '/api/users/tipsender/tips', { body: { amount: 5 }, cookie: ca })).status, 400, 'not yourself')
  assert.equal((await call('POST', '/api/users/nobodyhere123/tips', { body: { amount: 5 }, cookie: ca })).status, 404)
  assert.equal((await call('POST', '/api/users/tipreceiver/tips', { body: { amount: -1 }, cookie: ca })).status, 400)
  assert.equal((await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 1, txHash: '0x12' }, cookie: ca })).status, 400)
})

test('onchain sweep: a tip the app never recorded notifies the owner of the receiving wallet, once', async () => {
  const before = (await notifs(cb)).length
  head += 100
  // from a wallet outside the app, to the receiver's wallet, no post
  const h1 = tx()
  logs.push({ from: STRANGER.address, creator: B.address, amount: parseEther('50'), fee: parseEther('1'), hash: h1, block: head - 10 })
  // from the app user, client call failed (no row)
  const h2 = tx()
  logs.push({ from: A.address, creator: B.address, amount: parseEther('20'), fee: parseEther('0.4'), hash: h2, block: head - 9 })
  // to a wallet no account owns: ignored
  logs.push({ from: A.address, creator: key().address, amount: parseEther('7'), fee: 0n, hash: tx(), block: head - 8 })
  assert.equal(await backfillTips(), 2)
  const t1 = await one<any>('SELECT * FROM tips WHERE tx_hash = ?', [h1])
  assert.equal(Number(t1.verified), 1); assert.equal(Number(t1.from_id), 0); assert.equal(Number(t1.amount), 50)
  const ns = await notifs(cb)
  assert.equal(ns.length, before + 2)
  const out = ns.find(n => n.meta.gross === 50)
  assert.equal(out.meta.amount, 49); assert.equal(out.meta.chain, true); assert.equal(out.actors.length, 0)
  assert.match(out.meta.from, /^0x[0-9a-f]{4}…[0-9a-f]{4}$/)
  const mine = ns.find(n => n.meta.gross === 20)
  assert.equal(mine.actors[0].handle, 'tipsender'); assert.equal(mine.meta.amount, 19.6)
  // the late client call for h2 doesn't add a second row or notification
  resetRateLimits()
  assert.equal((await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 20, txHash: h2 }, cookie: ca })).body.already, true)
  // a second pass over the same blocks adds nothing
  await one("UPDATE kv SET v = '0' WHERE k = 'tips:cursor'")
  assert.equal(await backfillTips(), 0)
  assert.equal((await notifs(cb)).length, before + 2)
})

test('onchain sweep settles tips the app recorded (no second row), and maps a post tip to its drop', async () => {
  resetRateLimits()
  const before = (await notifs(cb)).length
  const h = tx()
  assert.equal((await call('POST', '/api/users/tipreceiver/tips', { body: { amount: 3, txHash: h }, cookie: ca })).status, 200)
  const d = await call('POST', '/api/drops', { body: { text: 'a drop to tip' }, cookie: cb })
  assert.equal(d.status, 201, JSON.stringify(d.body)); const dropId = String(d.body.drop?.id ?? d.body.id)
  const hp = tx()
  head += 100
  logs.push({ from: A.address, creator: B.address, amount: parseEther('3'), fee: 0n, hash: h, block: head - 5 })
  logs.push({ from: A.address, creator: B.address, postId: keccak256(toBytes(`post:${dropId}`)), amount: parseEther('10'), fee: parseEther('0.2'), hash: hp, block: head - 4 })
  assert.equal(await backfillTips(), 2) // the app's pending row for h is settled by its log, the post tip is new
  assert.equal((await all('SELECT id FROM tips WHERE tx_hash = ?', [h])).length, 1, 'no second row for a recorded tip')
  assert.equal(Number((await one<any>('SELECT verified FROM tips WHERE tx_hash = ?', [h])).verified), 1)
  const tp = await one<any>('SELECT * FROM tips WHERE tx_hash = ?', [hp])
  assert.equal(tp.drop_id, dropId)
  assert.equal(Number((await one<any>('SELECT tip_total FROM drops WHERE id = ?', [dropId])).tip_total), 10)
  const ns = await notifs(cb)
  assert.equal(ns.length, before + 2) // the client-recorded one (once proven) + the swept post tip
  assert.equal(ns.find(n => n.meta.gross === 10).drop.id, dropId)
})

test('a chat tip whose hash the sweep found first still drops the bubble, without a second notification', async () => {
  resetRateLimits()
  const h = tx()
  head += 100
  logs.push({ from: A.address, creator: B.address, amount: parseEther('4'), fee: 0n, hash: h, block: head - 3 })
  assert.equal(await backfillTips(), 1)
  const before = (await notifs(cb)).length
  const r = await call('POST', '/api/dms/tipreceiver/tip', { body: { amount: 4, txHash: h }, cookie: ca })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.message.kind, 'tip')
  assert.equal((await all('SELECT id FROM tips WHERE tx_hash = ?', [h])).length, 1)
  assert.equal((await notifs(cb)).length, before)
  assert.equal((await call('POST', '/api/dms/tipreceiver/tip', { body: { amount: 4, txHash: h }, cookie: ca })).status, 409)
})

test('admin wallet lookup: owners see which account has a wallet; everyone else gets 404', async () => {
  resetRateLimits()
  assert.equal((await call('GET', `/api/admin/wallet/${B.address}`, { cookie: ca })).status, 404, 'admin off: 404')
  process.env.ADMIN_ADDRESSES = C.address
  try {
    assert.equal((await call('GET', `/api/admin/wallet/${B.address}`, { cookie: ca })).status, 404, 'not an admin: 404')
    assert.equal((await call('GET', `/api/admin/wallet/${B.address}`)).status, 404, 'signed out: 404')
    const r = await call('GET', `/api/admin/wallet/${B.address}`, { cookie: cc })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.account.handle, 'tipreceiver'); assert.equal(r.body.account.kind, 'main'); assert.equal(r.body.account.id, await uidOf('tipreceiver'))
    assert.equal(r.body.address, B.address.toLowerCase())
    const none = await call('GET', `/api/admin/wallet/${STRANGER.address}`, { cookie: cc })
    assert.equal(none.status, 200); assert.equal(none.body.account, null)
    assert.equal((await call('GET', '/api/admin/wallet/0x1234', { cookie: cc })).status, 400)
    assert.ok(await one("SELECT 1 FROM admin_audit WHERE action = 'wallet_lookup'").catch(() => true))
  } finally { delete process.env.ADMIN_ADDRESSES }
})
