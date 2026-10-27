/** .wif: claim (preview mirror), primary + reverse display, records validation (256-byte bio, https/ipfs), public page, unclaimed resolves to no wallet. */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-names-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
// bot friction is covered in abuse.test.ts; these suites create many accounts from one IP
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.NAMES_CONTRACT_ADDRESS; delete process.env.BADGES_CONTRACT_ADDRESS; delete process.env.WIFLY_CONTRACT_ADDRESS
delete process.env.NAMES_RENDERER_ADDRESS; delete process.env.REDIS_URL; delete process.env.AGENT_PRIVATE_KEY; delete process.env.AGENT_TX_ENABLED

const { app } = await import('../src/app')
const { migrate, db } = await import('../src/db')
const { seed } = await import('./fixtures/seed')
const { resetRateLimits } = await import('../src/util')


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
  return { cookie: r.cookie!, me: r.body.me, address: acct.address.toLowerCase() }
}

before(async () => { await migrate(); await seed({ quiet: true }) })
after(() => { db.close?.(); rmSync(dir, { recursive: true, force: true }) })

test('claim, primary, reverse shows label.wif', async () => {
  resetRateLimits()
  const a = await signIn()
  const label = `t${Date.now().toString(36).slice(-8)}`
  const c = await call('POST', '/api/names/claim', { cookie: a.cookie, body: { name: `${label}.wif` } })
  assert.equal(c.status, 201, JSON.stringify(c.body))
  assert.equal(c.body.name, label)
  assert.equal(c.body.primary, label)
  const r = await call('GET', `/api/names/reverse/${a.address}`)
  assert.equal(r.body.name, label)
  assert.equal(r.body.display, `${label}.wif`)
  const v = await call('GET', `/api/names/${label}.wif`)
  assert.equal(v.body.claimed, true)
  assert.equal(v.body.primary, true)
})

test('records: bio over 256 bytes rejected, ipfs avatar ok, non-owner blocked', async () => {
  resetRateLimits()
  const a = await signIn(); const b = await signIn()
  const label = `r${Date.now().toString(36).slice(-8)}`
  assert.equal((await call('POST', '/api/names/claim', { cookie: a.cookie, body: { name: label } })).status, 201)
  const long = '🙂'.repeat(65) // 260 bytes, 65 characters
  assert.equal((await call('PUT', `/api/names/${label}/records`, { cookie: a.cookie, body: { bio: long } })).status, 400)
  assert.equal((await call('PUT', `/api/names/${label}/records`, { cookie: a.cookie, body: { url: 'http://insecure.example' } })).status, 400)
  const ok = await call('PUT', `/api/names/${label}/records`, { cookie: a.cookie, body: { bio: 'hello', avatar: 'ipfs://bafyexample', x: '@someone', url: 'https://example.com' } })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.records.x, 'someone')
  assert.equal((await call('PUT', `/api/names/${label}/records`, { cookie: b.cookie, body: { bio: 'mine now' } })).status, 403)
})

test('unclaimed names resolve to no wallet; reserved names cannot be claimed', async () => {
  resetRateLimits()
  const v = await call('GET', '/api/names/zzunclaimedzz.wif')
  assert.equal(v.body.claimed, false)
  const res = await call('GET', '/api/names/resolve/zzunclaimedzz.wif')
  assert.ok(res.status === 404 || res.body?.address == null)
  const a = await signIn()
  for (const n of ['wifly', 'marv', 'wif']) assert.equal((await call('POST', '/api/names/claim', { cookie: a.cookie, body: { name: n } })).status, 409)
})

test('name art: the compiled WiflyNameRenderer draws the card (svg, rare <= 4 chars, reserved, bad input 400)', async () => {
  const get = (p: string) => app.request(`http://localhost:5173${p}`, { headers: { host: 'localhost:5173' } })
  const r = await get('/api/names/art/ivy_lines.svg')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') ?? '', /image\/svg\+xml/)
  assert.equal(r.headers.get('x-wifly-art-source'), 'compiled-renderer')
  const svg = await r.text()
  assert.ok(svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'))
  assert.ok(svg.includes('ivy_lines.wif'))
  const { renderNameSvg, unclaimedPreview } = await import('../src/names-art')
  const full = await renderNameSvg('ivy_lines', false, false)
  assert.ok(full.includes('translate(96 912)'), 'the renderer draws the token id line')
  assert.equal(svg, unclaimedPreview(full), 'an unclaimed preview is the renderer output minus the token id line')
  assert.ok(!svg.includes('translate(96 912)'), 'no 0x… on a card nobody holds')
  const rare = await (await get('/api/names/art/zed.svg')).text()
  assert.equal(rare, unclaimedPreview(await renderNameSvg('zed', true, false)), 'names of 4 chars or fewer are drawn as rare')
  assert.notEqual(rare, unclaimedPreview(await renderNameSvg('zed', false, false)))
  const reserved = await (await get('/api/names/art/WIFLY.svg')).text()
  assert.equal(reserved, unclaimedPreview(await renderNameSvg('wifly', false, true)), 'reserved names are marked (and the label is lowercased)')
  assert.notEqual(reserved, unclaimedPreview(await renderNameSvg('wifly', false, false)))
  assert.equal((await get('/api/names/art/bad-name!.svg')).status, 400)
  assert.equal((await get('/api/names/art/' + 'a'.repeat(33) + '.svg')).status, 400)
})

test('name art themes: ?t=1 white, ?t=2 green, theme 0 = rare green / others white; stored theme is used and kept', async () => {
  const { renderNameSvg, unclaimedPreview } = await import('../src/names-art')
  const w = await renderNameSvg('ivy_lines', false, false, undefined, 1)
  const g = await renderNameSvg('ivy_lines', false, false, undefined, 2)
  assert.notEqual(w, g)
  assert.equal(await renderNameSvg('ivy_lines', false, false, undefined, 0), w, 'standard names default to white')
  assert.equal(await renderNameSvg('zed', true, false, undefined, 0), await renderNameSvg('zed', true, false, undefined, 2), 'rare names default to green')
  const r = await app.request('/api/names/art/ivy_lines.svg?t=2')
  assert.equal(r.status, 200)
  assert.equal(await r.text(), unclaimedPreview(g))
})
