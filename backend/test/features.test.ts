/** Onboarding, names market, tiers, paid drops, Plus renewal states, badges and the price endpoint. `npm test` */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-feat-'))
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
const { applyPlusPayment, duePlusRenewals, plusView } = await import('../src/features')
const { store } = await import('../src/cache')

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
  return { cookie: r.cookie!, me: r.body.me, uid: Number((await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', [r.body.me.handle]))!.id) }
}
const TX = `0x${'ab'.repeat(32)}`

before(async () => { await migrate(); await seed({ quiet: true }) })
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('handle check follows WiflyNames rules and shows the claim fee', async () => {
  resetRateLimits()
  const bad = await call('GET', '/api/handles/check?h=ab')
  assert.equal(bad.body.reason, 'invalid')
  assert.equal((await call('GET', '/api/handles/check?h=has-dash')).body.reason, 'invalid')
  assert.equal((await call('GET', '/api/handles/check?h=robinhood')).body.reason, 'reserved')
  const taken = await call('GET', '/api/handles/check?h=noravale')
  assert.equal(taken.body.available, false)
  assert.ok(taken.body.suggestions.length > 0)
  const free = await call('GET', '/api/handles/check?h=Fresh_Name_42')
  assert.equal(free.body.available, true)
  assert.equal(free.body.handle, 'fresh_name_42', 'lowercased like the contract')
  assert.equal(free.body.claimFee, 100)
  assert.equal((await call('GET', '/api/handles/check?h=zqx')).body.claimFee, 1000, '3-4 char names cost 1,000 WIF')
})

test('onboarding sets handle, profile, follows and interests', async () => {
  const u = await signIn()
  const ob = await call('GET', '/api/onboarding', { cookie: u.cookie })
  assert.equal(ob.status, 200)
  assert.ok(ob.body.users.length > 0 && ob.body.tags.length > 0)
  const r = await call('POST', '/api/onboarding', { cookie: u.cookie, body: { handle: 'globe_trotter', name: 'Globe', bio: 'hi', follow: ['noravale', 'junoflat'], tags: ['maps', 'zines'] } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.me.handle, 'globe_trotter')
  assert.equal(r.body.me.onboarded, true)
  assert.equal(r.body.me.following, 2)
  assert.equal((await call('GET', '/api/handles/check?h=globe_trotter', { cookie: u.cookie })).body.reason, 'yours')
  assert.equal((await call('POST', '/api/onboarding', { cookie: u.cookie, body: { handle: 'noravale' } })).status, 409)
})

test('names: claim, list (not your primary), offer, accept, buy needs the contract', async () => {
  const seller = await signIn(), buyer = await signIn()
  const cl = await call('POST', '/api/names/claim', { cookie: seller.cookie, body: { name: 'sunrise_club' } })
  assert.equal(cl.status, 201, JSON.stringify(cl.body))
  assert.equal(cl.body.claimFee, 100)
  assert.equal(cl.body.primary, 'sunrise_club', 'first .wif becomes primary')
  assert.equal((await call('POST', '/api/names/sunrise_club/list', { cookie: seller.cookie, body: { price: 10 } })).status, 200, 'your main .wif can be listed from its pill (if it sells, the @name goes back to the name step)')
  assert.equal((await call('POST', '/api/names/claim', { cookie: seller.cookie, body: { name: 'sunrise_two' } })).status, 201)
  assert.equal((await call('POST', '/api/names/sunrise_two/primary', { cookie: seller.cookie })).status, 200)
  const l = await call('POST', '/api/names/sunrise_club/list', { cookie: seller.cookie, body: { price: 5000 } })
  assert.equal(l.status, 200)
  assert.equal(l.body.listing.fee.total, 125, '2.5% fee')
  assert.equal(l.body.listing.fee.burn, 12.5, '10% of the fee burned')
  assert.equal(l.body.listing.fee.treasury, 0, 'the treasury takes nothing from sale fees')
  assert.equal(l.body.listing.fee.pot, 112.5, '90% of the fee to the weekly community pot')
  const m = await call('GET', '/api/names/market?sort=low')
  assert.ok(m.body.listings.some((x: any) => x.name === 'sunrise_club'))
  const off = await call('POST', '/api/names/sunrise_club/offers', { cookie: buyer.cookie, body: { price: 4000 } })
  assert.equal(off.status, 201)
  const mine = await call('GET', '/api/names/mine', { cookie: seller.cookie })
  assert.equal(mine.body.offersIn[0].price, 4000)
  assert.equal((await call('POST', `/api/names/offers/${off.body.id}/accept`, { cookie: seller.cookie })).status, 200)
  assert.equal((await one<{ price: number }>('SELECT price FROM name_listings WHERE name = ?', ['sunrise_club']))!.price, 4000)
  const n = await call('GET', '/api/notifications', { cookie: buyer.cookie })
  assert.ok(JSON.stringify(n.body).includes('name_offer_accepted'))
  const buy = await call('POST', '/api/names/sunrise_club/buy', { cookie: buyer.cookie, body: { txHash: TX } })
  assert.equal(buy.status, 503, 'no contract, nothing bought')
  assert.equal((await call('DELETE', '/api/names/sunrise_club/list', { cookie: seller.cookie })).status, 200)
})

test('tiers and paid drops: locked text stays on the server', async () => {
  const c = await signIn(), v = await signIn()
  assert.equal((await call('PUT', '/api/me/tiers', { cookie: c.cookie, body: { tiers: [{ name: 'a', price: 100 }, { name: 'b', price: 50 }] } })).status, 400)
  const t = await call('PUT', '/api/me/tiers', { cookie: c.cookie, body: { tiers: [{ name: 'fan', price: 100, perks: ['early drops'] }, { name: 'patron', price: 500 }] } })
  assert.equal(t.status, 200)
  assert.equal(t.body.me.tiers.length, 2)
  const d = await call('POST', '/api/drops', { cookie: c.cookie, body: { text: 'the secret map', locked: { price: 250, teaser: 'a map nobody has' } } })
  assert.equal(d.status, 201, JSON.stringify(d.body))
  const s = await call('POST', '/api/drops', { cookie: c.cookie, body: { text: 'for fans', supportersOnly: 't1' } })
  assert.equal(s.status, 201)
  const asViewer = await call('GET', `/api/drops/${d.body.drop.id}`, { cookie: v.cookie })
  const vd = asViewer.body.drop ?? asViewer.body
  assert.equal(vd.text, '')
  assert.equal(vd.lockedHidden, true)
  assert.equal(vd.locked.price, 250)
  const asAuthor = await call('GET', `/api/drops/${d.body.drop.id}`, { cookie: c.cookie })
  assert.equal((asAuthor.body.drop ?? asAuthor.body).text, 'the secret map')
  assert.equal((await call('POST', '/api/drops', { cookie: c.cookie, body: { text: 'x', locked: { price: 0, teaser: 'y' } } })).status, 400)
})

test('plus: active → grace → expired, auto-renew rules, price changed', async () => {
  const u = await signIn()
  assert.equal((await call('GET', '/api/plus', { cookie: u.cookie })).body.state, 'none')
  assert.equal((await call('POST', '/api/plus/payments', { cookie: u.cookie, body: { plan: 'month', txHash: TX } })).status, 503)
  const day = 86400_000, t0 = Date.now()
  await applyPlusPayment(u.uid, 'month', false, t0)
  let v = await plusView(u.uid, t0 + day)
  assert.equal(v.state, 'active'); assert.equal(v.check, true); assert.equal(v.price, 1500)
  assert.deepEqual(v.plans.map((p: any) => p.price), [1500, 15000])
  assert.equal((await call('POST', '/api/plus/auto-renew', { cookie: u.cookie, body: { on: true, agreedPrice: 1000, plan: 'month' } })).status, 400, 'agreed price must cover the plan')
  const on = await call('POST', '/api/plus/auto-renew', { cookie: u.cookie, body: { on: true, agreedPrice: 1500, plan: 'month' } })
  assert.equal(on.body.autoRenew, true)
  v = await plusView(u.uid, t0 + 31 * day)
  assert.equal(v.state, 'grace'); assert.equal(v.check, true); assert.equal(v.renewableNow, true)
  assert.equal((await duePlusRenewals(t0 + 31 * day)).filter(r => r.userId === u.uid).length, 1)
  // price goes up above the agreed price: renewal stops and asks to confirm
  process.env.PLUS_PRICE_MONTH = '2000'
  v = await plusView(u.uid, t0 + 31 * day)
  assert.equal(v.priceChanged, true); assert.equal(v.renewableNow, false)
  assert.equal((await duePlusRenewals(t0 + 31 * day)).filter(r => r.userId === u.uid).length, 0)
  delete process.env.PLUS_PRICE_MONTH
  // renewal inside grace keeps the calendar, and only once per period
  const exp = (await plusView(u.uid)).expiresAt!
  const next = await applyPlusPayment(u.uid, 'month', true, t0 + 31 * day)
  assert.equal(next, exp + 30 * day)
  // off stops it at once
  await call('POST', '/api/plus/auto-renew', { cookie: u.cookie, body: { on: false } })
  assert.equal((await plusView(u.uid)).autoRenew, false)
  v = await plusView(u.uid, next + 6 * day)
  assert.equal(v.state, 'expired'); assert.equal(v.check, false)
  // hydrated user shows plus (and grace)
  await run('UPDATE plus_subs SET expires_at = ? WHERE user_id = ?', [Date.now() - day, u.uid])
  const me = await call('GET', '/api/me', { cookie: u.cookie })
  const m = me.body.me ?? me.body
  assert.equal(m.plus, true); assert.equal(m.plusGrace, true)
})

test('badges: tiers by cumulative burn; burns need the contract', async () => {
  const b = await call('GET', '/api/badges/noravale')
  assert.equal(b.status, 200)
  assert.deepEqual(b.body.tiers.map((t: any) => t.min), [1000, 10000, 100000, 1000000])
  // No fabricated burns: seed accounts start at zero until a verified burn is recorded.
  assert.equal(b.body.top, null); assert.equal(b.body.burned, 0); assert.equal(b.body.demo, undefined)
  const nora = await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', ['noravale'])
  await run('INSERT INTO badge_burns (user_id, amount, tx_hash, verified, created_at) VALUES (?, ?, ?, 1, ?)', [nora!.id, 15000, '0x' + 'b'.repeat(64), Date.now()])
  assert.equal((await call('GET', '/api/badges/noravale')).body.top, 'flat-earther')
  const u = await signIn()
  assert.equal((await call('POST', '/api/badges/burns', { cookie: u.cookie, body: { amount: 1000, txHash: TX } })).status, 503)
})

test('price: served from the shared cache, quotes validate input, healthz answers', async () => {
  const p = { usd: 0.0012, eth: 5e-7, wifPerEth: 2e6, ethUsd: 2400, source: { wif: 'uniswap-v4', ethUsd: 'chainlink' }, updatedAt: Date.now(), stale: false, poolId: '0x71' }
  await store.set('price:wif:v1', JSON.stringify(p), 60_000)
  const r = await call('GET', '/api/price')
  assert.equal(r.status, 200); assert.equal(r.body.usd, 0.0012)
  assert.equal((await call('GET', '/api/swap/quote?dir=eth2wif&amount=abc')).status, 400)
  assert.equal((await call('GET', '/healthz')).status, 200)
})

test('.wif name service: check, records, resolve to the owner wallet (never the @handle), reverse, reset on transfer', async () => {
  resetRateLimits()
  const flat = await call('GET', '/api/names/check?n=flat.wif')
  assert.equal(flat.body.reason, 'listed')
  assert.equal(flat.body.price, 250000)
  assert.equal((await call('GET', '/api/names/check?n=marv')).body.reason, 'reserved')
  assert.equal((await call('GET', '/api/names/check?n=Brand_New_9')).body.display, 'brand_new_9.wif')
  const a = await signIn(), b = await signIn()
  await call('POST', '/api/onboarding', { cookie: b.cookie, body: { handle: 'tidepool_b' } })
  // Free @names are not reservations: anyone can claim the matching .wif, and the free holder gets a bump notice.
  const c3 = await signIn()
  assert.equal((await call('POST', '/api/names/claim', { cookie: c3.cookie, body: { name: 'tidepool_b' } })).status, 201, 'no first dibs on a .wif')
  assert.equal((await call('GET', '/api/me/identity', { cookie: b.cookie })).body.bump.handle, 'tidepool_b')
  assert.equal((await call('POST', '/api/names/claim', { cookie: a.cookie, body: { name: 'tidepool' } })).status, 201)
  const bad = await call('PUT', '/api/names/tidepool/records', { cookie: a.cookie, body: { address: 'nope' } })
  assert.equal(bad.status, 400)
  assert.equal((await call('PUT', '/api/names/tidepool/records', { cookie: a.cookie, body: { bio: 'é'.repeat(129) } })).status, 400, 'bio is capped at 256 bytes, not characters')
  assert.equal((await call('PUT', '/api/names/tidepool/records', { cookie: b.cookie, body: { bio: 'hi' } })).status, 403, 'only the holder edits records')
  const addr = '0x' + '12'.repeat(20)
  const rec = await call('PUT', '/api/names/tidepool/records', { cookie: a.cookie, body: { address: addr, x: '@tide', url: 'https://tide.example', bio: 'tides' } })
  assert.equal(rec.status, 200, JSON.stringify(rec.body))
  assert.equal(rec.body.records.x, 'tide')
  const r = await call('GET', '/api/names/resolve/tidepool.wif')
  assert.equal(r.body.address, addr)
  assert.equal(r.body.owner.handle, 'tidepool', 'resolves to the holder, whose @name is now tidepool')
  const page = await call('GET', '/api/names/tidepool')
  assert.equal(page.body.records.bio, 'tides')
  assert.equal(page.body.owner.wifName, 'tidepool')
  const me = await call('GET', '/api/names/mine', { cookie: a.cookie })
  assert.equal(me.body.primary, 'tidepool')
  const { resetNameOnTransfer } = await import('../src/features')
  await resetNameOnTransfer('tidepool', a.uid)
  assert.equal((await call('GET', '/api/names/tidepool')).body.records.bio, null, 'records reset on sale')
  assert.equal((await call('GET', '/api/names/mine', { cookie: a.cookie })).body.primary, null)
  assert.equal((await call('GET', '/api/names/resolve/nobody_has_this')).status, 404)
})

test('security headers: API can’t be framed', async () => {
  const r = await app.request('http://localhost:5173/healthz')
  assert.equal(r.headers.get('x-frame-options'), 'DENY')
  assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
})
