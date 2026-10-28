/** An old account takes its .wif as its @name, "use my .wif", tip destination, and the marketplace mirror. `npm test` */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, toBytes, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-s113b-'))
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
  'function isAvailable(string) view returns (bool)', 'function reverseName(address) view returns (string)', 'function resolve(string) view returns (address)',
  'function listings(uint256) view returns (address seller, uint256 price)', 'function nameOfToken(uint256) view returns (string)'])
const CLAIMED = parseAbi(['event NameClaimed(uint256 indexed tokenId, string name, address indexed owner, uint256 fee)'])
const owners = new Map<string, string>() // name → owner
const listed = new Map<string, { seller: string; price: bigint }>() // name → onchain listing
const resolves = new Map<string, string>() // name → setAddr record
const xferLogs: { name: string; from: string; to: string; block: number }[] = []
const XFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'])
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
    const t0 = String(params[0].topics?.[0] ?? '').toLowerCase()
    const xt = String(encodeEventTopics({ abi: XFER, eventName: 'Transfer' })[0]).toLowerCase()
    if (t0 === xt) return xferLogs.filter(l => l.block >= f && l.block <= t).map((l, i) => ({ address: N, topics: encodeEventTopics({ abi: XFER, eventName: 'Transfer', args: { from: l.from as Hex, to: l.to as Hex, tokenId: tid(l.name) } }) as Hex[], data: '0x',
      blockHash: h('b'), blockNumber: pad(l.block), transactionHash: h(`x${i}`), transactionIndex: '0x0', logIndex: pad(i), removed: false }))
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
      case 'resolve': { const n = String(f.args[0]).replace(/\.wif$/, ''); return addr(owners.has(n) ? resolves.get(n) ?? owners.get(n) : undefined) }
      case 'listings': { const n = nameByTid(f.args[0] as bigint); const l = n ? listed.get(n) : undefined; return encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [(l?.seller ?? ZERO) as Hex, l?.price ?? 0n]) }
      case 'nameOfToken': return encodeAbiParameters([{ type: 'string' }], [nameByTid(f.args[0] as bigint) ?? ''])
      case 'isAvailable': return encodeAbiParameters([{ type: 'bool' }], [!owners.has(String(f.args[0]))])
      case 'reverseName': return encodeAbiParameters([{ type: 'string' }], [primaries.get(String(f.args[0]).toLowerCase()) ?? ''])
      case 'ownerOf': { const n = nameByTid(f.args[0] as bigint); if (!n) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' }); return addr(owners.get(n)) }
    }
  }
  throw new Error(`unexpected ${method}`)
} }))
/** An onchain transfer (opensea sale, plain send): the contract clears the listing and the sender's primary. */
function transfer(name: string, to: string, block = 950) {
  const from = owners.get(name)!; owners.set(name, to); listed.delete(name); resolves.delete(name)
  if (primaries.get(from.toLowerCase()) === `${name}.wif`) primaries.delete(from.toLowerCase())
  xferLogs.push({ name, from, to, block })
}
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

const { reconcileAll } = await import('../src/reconcile')
const { invalidate } = await import('../src/cache')
const { syncListings } = await import('../src/market')
const wei = (n: number) => BigInt(n) * 10n ** 18n
const uidOf = async (cookie?: string) => meId(cookie)
const extras = async (id: number) => JSON.parse((await one<any>('SELECT extras FROM users WHERE id = ?', [id]))!.extras || '{}')
async function prove(cookie: string, acct: PrivateKeyAccount, purpose: 'wif' | 'tips') {
  const p = await call('POST', '/api/wallet/proof', { body: { purpose, address: acct.address }, cookie })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  return { address: acct.address, nonce: p.body.nonce, signature: await acct.signMessage({ message: p.body.message }), message: p.body.message as string }
}

test('first boot: the live @ass account (its wallet holds marvpeggy.wif) becomes @marvpeggy; photo, posts and id kept', async () => {
  resetRateLimits()
  const marv = privateKeyToAccount(generatePrivateKey())
  const s = await signInRaw(marv)
  const uid = (await uidOf(s.cookie))!
  await run(`UPDATE users SET handle = 'ass', name = 'ass', avatar = '/uploads/marv-pfp.webp', onboarded = 1, extras = '{"handlePicked":1}' WHERE id = ?`, [uid])
  await run("INSERT INTO drops (id, author_id, text, created_at) VALUES ('marvdrop01', ?, 'gm', ?)", [uid, Date.now()])
  mint('marvpeggy', marv.address); await invalidate('rpc')
  await reconcileAll({ url: process.env.DATABASE_URL, log: () => {} })
  const u = (await one<any>('SELECT handle, name, avatar FROM users WHERE id = ?', [uid]))!
  assert.equal(u.handle, 'marvpeggy'); assert.equal(u.avatar, '/uploads/marv-pfp.webp')
  assert.ok(await one("SELECT 1 FROM drops WHERE id = 'marvdrop01' AND author_id = ?", [uid]))
  const pub = (await call('GET', '/api/users/marvpeggy')).body.user
  assert.equal(pub.handle, 'marvpeggy'); assert.equal(pub.wifName, 'marvpeggy'); assert.equal(pub.avatar, '/uploads/marv-pfp.webp')
  assert.equal((await call('GET', '/api/users/ass')).status, 404)
  assert.equal((await call('GET', '/api/me', { cookie: s.cookie })).body.me.handle, 'marvpeggy')
})

test('use my .wif: a name bought elsewhere; the holding wallet signs a single-use nonce, the server reads ownerOfName, pill and @name move', async () => {
  resetRateLimits()
  const me = privateKeyToAccount(generatePrivateKey()), cold = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey())
  const s = await signInRaw(me)
  const uid = (await uidOf(s.cookie))!
  await call('POST', '/api/onboarding', { body: { handle: 'freepick', name: 'free' }, cookie: s.cookie })
  mint('boughtflat', other.address, false); transfer('boughtflat', cold.address); await invalidate('rpc')
  // a wallet that doesn't hold it: refused, even with a valid signature
  const bad = await prove(s.cookie!, other, 'wif')
  assert.equal((await call('POST', '/api/names/use', { body: { ...bad, name: 'boughtflat' }, cookie: s.cookie })).status, 409)
  // a signature from a different wallet than the one named: refused
  const p0 = await call('POST', '/api/wallet/proof', { body: { purpose: 'wif', address: cold.address }, cookie: s.cookie })
  assert.equal((await call('POST', '/api/names/use', { body: { address: cold.address, nonce: p0.body.nonce, signature: await other.signMessage({ message: p0.body.message }), name: 'boughtflat' }, cookie: s.cookie })).status, 401)
  // the nonce from that failed try is burned
  assert.equal((await call('POST', '/api/names/use', { body: { address: cold.address, nonce: p0.body.nonce, signature: await cold.signMessage({ message: p0.body.message }), name: 'boughtflat' }, cookie: s.cookie })).status, 400)
  // the holding wallet: works; the wallet is linked to this account
  const ok = await prove(s.cookie!, cold, 'wif')
  assert.match(ok.message, /not a transaction/)
  const r = await call('POST', '/api/names/use', { body: { ...ok, name: 'boughtflat.wif' }, cookie: s.cookie })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.me.handle, 'boughtflat'); assert.equal(r.body.me.wifName, 'boughtflat')
  assert.equal(await uidOf(s.cookie), uid)
  assert.ok(await one('SELECT 1 FROM user_wallets WHERE address = ? AND user_id = ?', [cold.address.toLowerCase(), uid]))
  // replaying the same signature: refused
  assert.equal((await call('POST', '/api/names/use', { body: { ...ok, name: 'boughtflat' }, cookie: s.cookie })).status, 400)
})

test('the sweep picks up a .wif sent to a linked wallet (opensea / plain transfer): buyer gets pill and @name, seller goes to the name step', async () => {
  resetRateLimits()
  const seller = privateKeyToAccount(generatePrivateKey()), buyer = privateKeyToAccount(generatePrivateKey())
  const ss = await signInRaw(seller), bs = await signInRaw(buyer)
  const sid = (await uidOf(ss.cookie))!, bid = (await uidOf(bs.cookie))!
  await call('POST', '/api/onboarding', { body: { handle: 'buyerfree', name: 'b' }, cookie: bs.cookie })
  mint('movedflat', seller.address); await invalidate('rpc')
  resetRateLimits(); await signInRaw(seller)
  assert.equal((await one<any>('SELECT handle FROM users WHERE id = ?', [sid]))!.handle, 'movedflat')
  transfer('movedflat', buyer.address); await invalidate('rpc')
  await verifyPending()
  assert.equal((await one<any>('SELECT handle FROM users WHERE id = ?', [bid]))!.handle, 'movedflat')
  assert.equal((await extras(bid)).wifName, 'movedflat')
  const s = (await one<any>('SELECT handle FROM users WHERE id = ?', [sid]))!
  assert.ok(s.handle.startsWith('~')); assert.equal((await extras(sid)).wifName, undefined)
})

test('tip destination: proven by a fresh signature from a linked wallet, logged, shown before tipping, counted by the tip verifier', async () => {
  resetRateLimits()
  const main = privateKeyToAccount(generatePrivateKey()), hot = privateKeyToAccount(generatePrivateKey()), stranger = privateKeyToAccount(generatePrivateKey())
  const s = await signInRaw(main)
  const uid = (await uidOf(s.cookie))!
  await call('POST', '/api/onboarding', { body: { handle: 'tipdest', name: 't' }, cookie: s.cookie })
  // default: the main wallet
  let p = (await call('GET', '/api/users/tipdest/payout')).body
  assert.equal(p.address, main.address.toLowerCase()); assert.equal(p.via, 'main')
  // a wallet that isn't on the account can't be chosen
  const sx = await prove(s.cookie!, stranger, 'tips')
  assert.equal((await call('POST', '/api/settings/tips', { body: sx, cookie: s.cookie })).status, 400)
  await run(`INSERT INTO user_wallets (address, user_id, kind, created_at) VALUES (?, ?, 'linked', ?)`, [hot.address.toLowerCase(), uid, Date.now()])
  // a signature by the main wallet for the hot wallet doesn't count
  const pr = await call('POST', '/api/wallet/proof', { body: { purpose: 'tips', address: hot.address }, cookie: s.cookie })
  assert.equal((await call('POST', '/api/settings/tips', { body: { address: hot.address, nonce: pr.body.nonce, signature: await main.signMessage({ message: pr.body.message }) }, cookie: s.cookie })).status, 401)
  // a proof for "use my .wif" can't be reused for tips
  const wrong = await prove(s.cookie!, hot, 'wif')
  assert.equal((await call('POST', '/api/settings/tips', { body: wrong, cookie: s.cookie })).status, 400)
  const okp = await prove(s.cookie!, hot, 'tips')
  const r = await call('POST', '/api/settings/tips', { body: okp, cookie: s.cookie })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.payout.address, hot.address.toLowerCase())
  assert.equal((await call('POST', '/api/settings/tips', { body: okp, cookie: s.cookie })).status, 400, 'every change needs a fresh signature')
  p = (await call('GET', '/api/users/tipdest/payout')).body
  assert.equal(p.address, hot.address.toLowerCase()); assert.equal(p.via, 'chosen')
  const st = (await call('GET', '/api/settings/tips', { cookie: s.cookie })).body
  assert.equal(st.changes.length, 1); assert.ok(st.wallets.length >= 2)
  assert.ok(lines.some(l => l.startsWith('[tips] destination')), 'logged')
  assert.ok(!lines.some(l => l.includes(hot.address.toLowerCase())), 'never the full wallet in logs')
})

test('tip destination follows the .wif resolver when nothing is chosen and it points at one of your wallets', async () => {
  resetRateLimits()
  const main = privateKeyToAccount(generatePrivateKey()), vault = privateKeyToAccount(generatePrivateKey())
  const s = await signInRaw(main)
  const uid = (await uidOf(s.cookie))!
  mint('resolvflat', main.address); await invalidate('rpc')
  resetRateLimits(); await signInRaw(main)
  await run(`INSERT INTO user_wallets (address, user_id, kind, created_at) VALUES (?, ?, 'linked', ?)`, [vault.address.toLowerCase(), uid, Date.now()])
  resolves.set('resolvflat', vault.address)
  const p = (await call('GET', '/api/users/resolvflat/payout')).body
  assert.equal(p.address, vault.address.toLowerCase()); assert.equal(p.via, 'name')
  // pointing it at a wallet that isn't yours doesn't redirect tips
  resolves.set('resolvflat', privateKeyToAccount(generatePrivateKey()).address)
  assert.equal((await call('GET', '/api/users/resolvflat/payout')).body.address, main.address.toLowerCase())
})

test('marketplace mirror: listing writes read WiflyNames.listings; cancel needs the chain; the sweep drops listings gone onchain or moved on opensea', async () => {
  resetRateLimits()
  const a = privateKeyToAccount(generatePrivateKey()), b = privateKeyToAccount(generatePrivateKey())
  const s = await signInRaw(a)
  mint('sellflat', a.address, false); mint('sell2flat', a.address, false); mint('sell3flat', a.address, false); await invalidate('rpc')
  for (const n of ['sellflat', 'sell2flat', 'sell3flat']) assert.equal((await call('GET', `/api/names/check?n=${n}`, { cookie: s.cookie })).body.reason, 'yours')
  for (const n of ['sellflat', 'sell2flat', 'sell3flat']) assert.ok(await one('SELECT 1 FROM names WHERE name = ? AND minted = 1', [n]), n)
  // no list tx yet: the mirror refuses the client's word
  assert.equal((await call('POST', '/api/names/sellflat/list', { body: { price: 5 }, cookie: s.cookie })).status, 409)
  // onchain list at 120 WIF; the client claims 5: the mirror stores the chain price
  listed.set('sellflat', { seller: a.address, price: wei(120) })
  const r = await call('POST', '/api/names/sellflat/list', { body: { price: 5 }, cookie: s.cookie })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.listing.price, 120)
  // delist while still listed onchain: refused; after the onchain cancel: removed
  assert.equal((await call('DELETE', '/api/names/sellflat/list', { cookie: s.cookie })).status, 409)
  listed.delete('sellflat')
  assert.equal((await call('DELETE', '/api/names/sellflat/list', { cookie: s.cookie })).status, 200)
  assert.equal(await one("SELECT 1 FROM name_listings WHERE name = 'sellflat'"), undefined)
  // two more listings; one is cancelled onchain behind our back, one is sold on opensea; the price of a third changes
  for (const n of ['sell2flat', 'sell3flat']) { listed.set(n, { seller: a.address, price: wei(50) }); assert.equal((await call('POST', `/api/names/${n}/list`, { body: { price: 50 }, cookie: s.cookie })).status, 200) }
  listed.set('sellflat', { seller: a.address, price: wei(70) }); await call('POST', '/api/names/sellflat/list', { body: {}, cookie: s.cookie })
  listed.delete('sell2flat')
  transfer('sell3flat', b.address)
  listed.set('sellflat', { seller: a.address, price: wei(90) })
  await syncListings()
  assert.equal(await one("SELECT 1 FROM name_listings WHERE name = 'sell2flat'"), undefined)
  assert.equal(await one("SELECT 1 FROM name_listings WHERE name = 'sell3flat'"), undefined)
  assert.equal(Number((await one<any>("SELECT price FROM name_listings WHERE name = 'sellflat'"))!.price), 90)
  // a stale listing whose seller lost the name (even if the chain still has the old seller's record) never stays
  listed.set('sell3flat', { seller: a.address, price: wei(10) })
  await run("INSERT OR REPLACE INTO name_listings (name, seller_id, price, created_at) VALUES ('sell3flat', ?, 10, ?)", [(await uidOf(s.cookie))!, Date.now()])
  await syncListings()
  assert.equal(await one("SELECT 1 FROM name_listings WHERE name = 'sell3flat'"), undefined)
})

test('guest links a wallet and x, signs out, signs back in with the wallet and with x: same id, @name and posts, no second account', async () => {
  resetRateLimits()
  const guestKey = privateKeyToAccount(generatePrivateKey()), wallet = privateKeyToAccount(generatePrivateKey())
  const embedded = privateKeyToAccount(generatePrivateKey()).address.toLowerCase()
  const xId = { did: 'did:privy:guestloop', xUserId: '5151', xUsername: 'guestloop', xName: 'guest loop', email: null, smartWallet: null, embeddedWallet: embedded, wallets: [embedded] }
  const g = await signInRaw(guestKey, { guest: true })
  const uid = (await meId(g.cookie))!
  assert.equal((await call('POST', '/api/onboarding', { body: { handle: 'guestloop', name: 'guest loop' }, cookie: g.cookie })).status, 200)
  await run("INSERT INTO drops (id, author_id, text, created_at) VALUES ('guestdrop1', ?, 'first post', ?)", [uid, Date.now()])
  // guests get the gentle "link a wallet or x" nudge until they do
  assert.equal((await call('GET', '/api/me', { cookie: g.cookie })).body.me.links.wallets.length, 0)
  assert.equal((await call('POST', '/api/auth/link/wallet', { body: await siwe(wallet), cookie: g.cookie })).status, 200)
  setPrivyVerifierForTests(() => xId as never)
  assert.equal((await call('POST', '/api/auth/link/privy', { body: { identityToken: 'x'.repeat(40) }, cookie: g.cookie })).status, 200)
  const count = Number((await one<any>('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL'))!.n)
  await call('POST', '/api/auth/logout', { cookie: g.cookie })
  const same = async (cookie: string | undefined, via: string) => {
    assert.equal(await meId(cookie), uid, via)
    const me = (await call('GET', '/api/me', { cookie })).body.me
    assert.equal(me.handle, 'guestloop', via); assert.equal(me.needsHandle, false, via)
    assert.ok(await one("SELECT 1 FROM drops WHERE id = 'guestdrop1' AND author_id = ?", [uid]), via)
  }
  resetRateLimits()
  await same((await signInRaw(wallet)).cookie, 'wallet')
  await same((await call('POST', '/api/auth/privy', { body: { identityToken: 'x'.repeat(40) } })).cookie, 'x')
  assert.equal(Number((await one<any>('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL'))!.n), count, 'no duplicate account')
  setPrivyVerifierForTests(null)
})
