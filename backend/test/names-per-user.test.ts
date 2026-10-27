// regression: every signed-in user sees their own @handle and name (never another user's), including when one of
// them owns a .wif and when the read caches are warm (3 rounds over the same endpoints, interleaved users).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'
const dir = mkdtempSync(join(tmpdir(), 'wifly-names-per-user-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'; process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.NAMES_CONTRACT_ADDRESS; delete process.env.BADGES_CONTRACT_ADDRESS; delete process.env.WIFLY_CONTRACT_ADDRESS; delete process.env.REDIS_URL
const { app } = await import('../src/app')
const { migrate, db, one, all } = await import('../src/db')
const { seed } = await import('./fixtures/seed')
const { resetRateLimits } = await import('../src/util')
async function call(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { host: 'localhost:5173', 'x-wifly': '1' }
  if (opts.cookie) headers.cookie = opts.cookie
  let body: BodyInit | undefined
  if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body) }
  const r = await app.request(`http://localhost:5173${path}`, { method, headers, body })
  const set = r.headers.get('set-cookie')
  return { status: r.status, body: await r.json().catch(() => null) as any, cookie: set ? set.split(';')[0] : undefined }
}
async function signIn() {
  const acct = privateKeyToAccount(generatePrivateKey())
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'x', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const r = await call('POST', '/api/auth/verify', { body: { message, signature: await acct.signMessage({ message }) } })
  // no made-up @names, so test accounts pick one like onboarding does
  if (r.body?.me) { const p = await call('PATCH', '/api/me', { body: { handle: 't' + acct.address.slice(2, 14).toLowerCase() }, cookie: r.cookie }); if (p.body?.me) r.body.me = p.body.me }
  return { cookie: r.cookie!, me: r.body.me }
}
before(async () => { await migrate(); await seed({ quiet: true }) })
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
test('names: two users each get their own name, with a .wif and with warm caches', async () => {
  resetRateLimits()
  const a = await signIn(); const b = await signIn()
  assert.equal((await call('POST', '/api/onboarding', { cookie: a.cookie, body: { handle: 'marvx', name: 'Marv' } })).status < 300, true)
  assert.equal((await call('POST', '/api/onboarding', { cookie: b.cookie, body: { handle: 'bob', name: 'Bob B' } })).status < 300, true)
  assert.equal((await call('POST', '/api/names/claim', { cookie: b.cookie, body: { name: 'bob', primary: true } })).status < 300, true)
  await call('POST', '/api/drops', { cookie: a.cookie, body: { text: 'hello from marv' } })
  await call('POST', '/api/drops', { cookie: b.cookie, body: { text: 'hello from bob' } })
  const dbu = new Map((await all<any>('SELECT handle, name FROM users')).map(r => [r.handle, r.name]))
  const paths = ['/api/me', '/api/feed?tab=foryou', '/api/feed?tab=following', '/api/feed/new', '/api/suggest/users?limit=10', '/api/creators', '/api/search?q=a', '/api/search?q=bob', '/api/names/market', '/api/names/mine', '/api/notifications', '/api/onboarding', '/api/me/identity', '/api/users/marvx', '/api/users/bob', '/api/users/noravale', '/api/users/marvx/drops', '/api/users/bob/drops', '/api/names/bob', '/api/names/marvx', '/api/names/resolve/bob', '/api/bookmarks', '/api/companion', '/api/agent', '/api/badges/marvx', '/api/badges/bob', '/api/trending', '/api/plus']
  const bad: string[] = []
  const walk = (o: any, where: string) => {
    if (!o || typeof o !== 'object') return
    if (typeof o.handle === 'string' && typeof o.name === 'string' && dbu.has(o.handle)) {
      const want = dbu.get(o.handle) === 'new on wifly' || !dbu.get(o.handle) ? o.handle : dbu.get(o.handle)
      if (o.name !== want) bad.push(`${where}: @${o.handle} name=${o.name} want=${want}`)
    }
    if (typeof o.name === 'string' && o.name === 'Marv' && o.handle !== 'marvx') bad.push(`${where}: leaked ${JSON.stringify(o).slice(0, 200)}`)
    for (const v of Object.values(o)) walk(v, where)
  }
  const want = { A: { handle: 'marvx', name: 'Marv', wifName: null }, B: { handle: 'bob', name: 'Bob B', wifName: 'bob' } } as const
  for (const round of [1, 2, 3]) for (const [who, ck] of [['A', a.cookie], ['B', b.cookie], ['anon', undefined]] as const) for (const p of paths) {
    const r = await call('GET', p, { cookie: ck })
    walk(r.body, `r${round} ${who} ${p} (${r.status})`)
    if (p !== '/api/me') continue
    if (who === 'anon') { assert.equal(r.body?.me ?? null, null, `round ${round}: anon /api/me has no user`); continue }
    const me = r.body?.me
    assert.deepEqual({ handle: me?.handle, name: me?.name, wifName: me?.wifName ?? null }, want[who], `round ${round}: /api/me for ${who}`)
    assert.equal(r.body?.login?.method, 'wallet', `round ${round}: ${who} signed in with a wallet`)
  }
  assert.deepEqual(bad, [], bad.join('\n'))
})
