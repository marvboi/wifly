/** 11.8.4: onboarding never follows anyone for you. only the people tapped get followed; nobody is fine. */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-1184-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.TURNSTILE_SECRET_KEY

const { app } = await import('../src/app')
const { migrate, db, all } = await import('../src/db')
const { seed } = await import('./fixtures/seed')
const { resetRateLimits } = await import('../src/util')

let ipSeq = 0
async function call(method: string, path: string, o: { body?: unknown; cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { host: 'localhost:5173', 'x-wifly': '1', 'x-forwarded-for': o.ip ?? '10.4.0.1' }
  if (o.cookie) headers.cookie = o.cookie
  let body: string | undefined
  if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body) }
  const r = await app.request(`http://localhost:5173${path}`, { method, headers, body })
  const set = r.headers.get('set-cookie')
  return { status: r.status, body: await r.json().catch(() => null) as any, cookie: set ? set.split(';')[0] : undefined }
}
async function newAccount() {
  resetRateLimits()
  const ip = `10.4.1.${++ipSeq}`
  const acct = privateKeyToAccount(generatePrivateKey())
  const { body: { nonce } } = await call('GET', '/api/auth/nonce', { ip })
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'sign in', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const r = await call('POST', '/api/auth/verify', { body: { message, signature: await acct.signMessage({ message }) }, ip })
  assert.equal(r.status, 200); assert.ok(r.cookie)
  const row = (await all<{ id: number }>('SELECT id FROM users WHERE lower(address) = ?', [acct.address.toLowerCase()]))[0]
  assert.ok(row, 'account row')
  return { cookie: r.cookie!, id: Number(row.id), handle: 'f' + acct.address.slice(2, 12).toLowerCase() }
}
const followsOf = async (id: number) => (await all<{ followee_id: number }>('SELECT followee_id FROM follows WHERE follower_id = ?', [id])).map(r => Number(r.followee_id))

before(async () => { await migrate(); await seed({ quiet: true }) })
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('a new account follows nobody, and the suggested people all come back unfollowed', async () => {
  const a = await newAccount()
  assert.deepEqual(await followsOf(a.id), [], 'sign-up must not auto-follow anyone')
  const onb = await call('GET', '/api/onboarding', { cookie: a.cookie })
  assert.equal(onb.status, 200)
  assert.ok(onb.body.users.length >= 2, 'fixture has suggested people')
  assert.ok(onb.body.users.every((u: any) => u.youFollow === false), 'nobody shows as followed before a tap')
  assert.deepEqual(await followsOf(a.id), [], 'opening the step follows nobody')
})

test('finishing with nobody picked (or no follow field) follows nobody and still onboards', async () => {
  for (const extra of [{ follow: [] }, {}]) {
    const a = await newAccount()
    const r = await call('POST', '/api/onboarding', { cookie: a.cookie, body: { handle: a.handle, ...extra } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.me.handle, a.handle)
    assert.deepEqual(await followsOf(a.id), [])
  }
})

test('only the people tapped get followed', async () => {
  const a = await newAccount()
  const users = (await call('GET', '/api/onboarding', { cookie: a.cookie })).body.users as { handle: string }[]
  const tapped = users[1]
  const r = await call('POST', '/api/onboarding', { cookie: a.cookie, body: { handle: a.handle, follow: [tapped.handle] } })
  assert.equal(r.status, 200)
  const tid = (await all<{ id: number }>('SELECT id FROM users WHERE handle = ? COLLATE NOCASE', [tapped.handle]))[0].id
  assert.deepEqual(await followsOf(a.id), [Number(tid)])
})
