/** Direct messages: requests, receipts, blocks, reports, delete for self, paging, limits, chat tips and the live stream. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-dms-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
delete process.env.REDIS_URL; delete process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_SECRET; delete process.env.ADMIN_ADDRESSES
delete process.env.DCA_KEEPER_ENABLED; delete process.env.NAMES_CONTRACT_ADDRESS; delete process.env.WIFLY_CONTRACT_ADDRESS

const { app } = await import('../src/app')
const { migrate, run, one, all } = await import('../src/db')
const { resetRateLimits } = await import('../src/util')
const { cleanText } = await import('../src/dms')
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
async function siwe(acct: PrivateKeyAccount) {
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'Sign in to Wifly. No transaction, no fee.', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  return { message, signature: await acct.signMessage({ message }) }
}
let n = 0
async function member(prefix = 'dm') {
  resetRateLimits()
  const acct = privateKeyToAccount(generatePrivateKey())
  const r = await call('POST', '/api/auth/verify', { body: await siwe(acct) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const handle = `${prefix}${++n}${Math.random().toString(36).slice(2, 6)}`
  const o = await call('POST', '/api/onboarding', { body: { handle }, cookie: r.cookie })
  assert.equal(o.status, 200, JSON.stringify(o.body))
  const id = Number((await one<{ id: number }>('SELECT id FROM users WHERE handle = ?', [handle]))!.id)
  return { cookie: r.cookie!, handle, id }
}
const send = (from: { cookie: string }, to: { handle: string }, text: string, extra: object = {}) => call('POST', `/api/dms/${to.handle}`, { body: { text, ...extra }, cookie: from.cookie })
const thread = (who: { cookie: string }, peer: { handle: string }, q = '') => call('GET', `/api/dms/${peer.handle}${q}`, { cookie: who.cookie })
const inbox = (who: { cookie: string }, tab = 'inbox') => call('GET', `/api/dms?tab=${tab}`, { cookie: who.cookie })
const ago = async (u: { id: number }, days: number) => run('UPDATE users SET created_at = ? WHERE id = ?', [Date.now() - days * 86_400_000, u.id])

test('signed out: every dm route asks you to sign in', async () => {
  for (const [m, p] of [['GET', '/api/dms'], ['GET', '/api/dms/unread'], ['GET', '/api/dms/someone'], ['POST', '/api/dms/someone'], ['GET', '/api/dms/stream']] as const)
    assert.equal((await call(m, p, m === 'POST' ? { body: { text: 'hi' } } : {})).status, 401, `${m} ${p}`)
})

test('a stranger lands in requests; replying accepts; unread counts and receipts follow', async () => {
  const a = await member(), b = await member()
  resetRateLimits()
  const s = await send(a, b, 'hey, love your drops')
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.message.mine, true)
  assert.equal(s.body.message.text, 'hey, love your drops')
  // a sees it in the inbox, b in requests
  assert.equal((await inbox(a)).body.items[0].peer.handle, b.handle)
  assert.equal((await inbox(b)).body.items.length, 0)
  const req = await inbox(b, 'requests')
  assert.equal(req.body.items.length, 1)
  assert.equal(req.body.items[0].request, true)
  assert.equal(req.body.items[0].unread, 1)
  assert.deepEqual(req.body.unread, { inbox: 0, requests: 1 })
  assert.deepEqual((await call('GET', '/api/me', { cookie: b.cookie })).body.dms, { inbox: 0, requests: 1 })
  // the thread view says it's a request for b and pending for a
  assert.equal((await thread(b, a)).body.request, true)
  assert.equal((await thread(a, b)).body.pending, true)
  // receipts stay quiet while it's a request
  await call('POST', `/api/dms/${a.handle}/read`, { cookie: b.cookie })
  // b replies: accepted, moves to inbox, unread clears
  assert.equal((await send(b, a, 'thank you!')).status, 200)
  assert.equal((await inbox(b)).body.items[0].peer.handle, a.handle)
  assert.equal((await inbox(b, 'requests')).body.items.length, 0)
  assert.deepEqual((await call('GET', '/api/dms/unread', { cookie: b.cookie })).body, { inbox: 0, requests: 0 })
  assert.deepEqual((await call('GET', '/api/dms/unread', { cookie: a.cookie })).body, { inbox: 1, requests: 0 })
  // a reads: b sees a's read mark on its message
  await call('POST', `/api/dms/${b.handle}/read`, { cookie: a.cookie })
  const tb = await thread(b, a)
  assert.equal(tb.body.peerRead, tb.body.items[tb.body.items.length - 1].id)
  assert.deepEqual((await call('GET', '/api/dms/unread', { cookie: a.cookie })).body, { inbox: 0, requests: 0 })
})

test('someone you follow goes straight to your inbox; accept moves a request over; one thread per pair', async () => {
  const a = await member(), b = await member(), c = await member()
  resetRateLimits()
  assert.equal((await call('POST', `/api/users/${a.handle}/follow`, { cookie: b.cookie })).status, 200)
  await send(a, b, 'hi b')
  await send(b, a, 'hi a')
  await send(a, b, 'again')
  assert.equal((await inbox(b)).body.items.length, 1)
  const rows = await all('SELECT id FROM dm_threads WHERE (lo_id = ? AND hi_id = ?) OR (lo_id = ? AND hi_id = ?)', [a.id, b.id, b.id, a.id])
  assert.equal(rows.length, 1)
  await send(c, b, 'hello from c')
  assert.equal((await inbox(b, 'requests')).body.items.length, 1)
  assert.equal((await call('POST', `/api/dms/${c.handle}/accept`, { cookie: b.cookie })).status, 200)
  assert.equal((await inbox(b, 'requests')).body.items.length, 0)
  assert.equal((await inbox(b)).body.items.length, 2)
})

test('a request holds a few messages until the other side answers', async () => {
  const a = await member(), b = await member()
  await ago(a, 30)
  resetRateLimits()
  for (let i = 0; i < 5; i++) assert.equal((await send(a, b, `msg ${i}`)).status, 200)
  const r = await send(a, b, 'one more')
  assert.equal(r.status, 429)
  assert.match(r.body.error, /accept your request/)
})

test('block hides the thread both ways and stops sends; unblock brings it back', async () => {
  const a = await member(), b = await member()
  resetRateLimits()
  await call('POST', `/api/users/${a.handle}/follow`, { cookie: b.cookie })
  await send(a, b, 'before the block')
  assert.equal((await call('POST', `/api/users/${a.handle}/block`, { cookie: b.cookie })).status, 200)
  assert.equal((await inbox(a)).body.items.length, 0)
  assert.equal((await inbox(b)).body.items.length, 0)
  const s = await send(a, b, 'are you there?')
  assert.equal(s.status, 403)
  assert.equal((await send(b, a, 'blocked side')).status, 403)
  const ta = await thread(a, b)
  assert.equal(ta.body.blocked, 'them'); assert.equal(ta.body.canMessage, false); assert.equal(ta.body.items.length, 0)
  assert.equal((await thread(b, a)).body.blocked, 'you')
  assert.equal((await call('GET', `/api/users/${b.handle}`, { cookie: a.cookie })).body.user.blocksYou, true)
  assert.equal((await call('GET', `/api/users/${a.handle}`, { cookie: b.cookie })).body.user.blocked, true)
  assert.equal((await call('GET', '/api/blocks', { cookie: b.cookie })).body.items[0].handle, a.handle)
  assert.equal((await call('DELETE', `/api/users/${a.handle}/block`, { cookie: b.cookie })).status, 200)
  assert.equal((await inbox(b)).body.items.length, 1)
  assert.equal((await send(a, b, 'back again')).status, 200)
})

test('report a person or one of their messages', async () => {
  const a = await member(), b = await member()
  resetRateLimits()
  const m = (await send(a, b, 'buy my coin now')).body.message
  assert.equal((await call('POST', `/api/dms/${a.handle}/report`, { body: { reason: 'spam', messageId: m.id, note: 'unsolicited' }, cookie: b.cookie })).status, 200)
  const r = await one<{ reason: string; message_id: number; target_id: number }>('SELECT * FROM reports WHERE reporter_id = ?', [b.id])
  assert.equal(r!.reason, 'spam'); assert.equal(Number(r!.message_id), m.id); assert.equal(Number(r!.target_id), a.id)
  // you can't pin someone else's words on them: a message id from the wrong sender is dropped
  await call('POST', `/api/dms/${b.handle}/report`, { body: { reason: 'abuse', messageId: m.id }, cookie: a.cookie })
  const r2 = await one<{ message_id: number | null }>('SELECT message_id FROM reports WHERE reporter_id = ?', [a.id])
  assert.equal(r2!.message_id, null)
})

test('delete for yourself: only your own messages, only for you', async () => {
  const a = await member(), b = await member()
  resetRateLimits()
  const m1 = (await send(a, b, 'oops typo')).body.message
  await send(a, b, 'fixed')
  assert.equal((await call('DELETE', `/api/dms/messages/${m1.id}`, { cookie: b.cookie })).status, 404)
  assert.equal((await call('DELETE', `/api/dms/messages/${m1.id}`, { cookie: a.cookie })).status, 200)
  assert.deepEqual((await thread(a, b)).body.items.map((x: any) => x.text), ['fixed'])
  assert.deepEqual((await thread(b, a)).body.items.map((x: any) => x.text), ['oops typo', 'fixed'])
})

test('history pages 30 at a time, oldest first within a page', async () => {
  const a = await member(), b = await member()
  await ago(a, 30)
  await call('POST', `/api/users/${a.handle}/follow`, { cookie: b.cookie })
  resetRateLimits()
  for (let i = 0; i < 35; i++) { if (i % 20 === 0) resetRateLimits(); assert.equal((await send(a, b, `m${i}`)).status, 200) }
  const p1 = await thread(b, a)
  assert.equal(p1.body.items.length, 30)
  assert.equal(p1.body.items[0].text, 'm5'); assert.equal(p1.body.items[29].text, 'm34')
  assert.ok(p1.body.next)
  const p2 = await thread(b, a, `?before=${p1.body.next}`)
  assert.deepEqual(p2.body.items.map((x: any) => x.text), ['m0', 'm1', 'm2', 'm3', 'm4'])
  assert.equal(p2.body.next, null)
})

test('new accounts get stricter limits: fewer messages and fewer new conversations', async () => {
  const fresh = await member(), old = await member()
  await ago(old, 30)
  const peers = await Promise.all(Array.from({ length: 6 }, () => member()))
  resetRateLimits()
  for (let i = 0; i < 5; i++) assert.equal((await send(fresh, peers[i]!, 'hi')).status, 200)
  assert.equal((await send(fresh, peers[5]!, 'hi')).status, 429) // a sixth new conversation today
  resetRateLimits()
  await call('POST', `/api/dms/${fresh.handle}/accept`, { cookie: peers[0]!.cookie })
  let ok = 0
  for (let i = 0; i < 25; i++) if ((await send(fresh, peers[0]!, `x${i}`)).status === 200) ok++
  assert.equal(ok, 20)
  resetRateLimits()
  await call('POST', `/api/users/${old.handle}/follow`, { cookie: peers[1]!.cookie })
  resetRateLimits()
  let ok2 = 0
  for (let i = 0; i < 25; i++) if ((await send(old, peers[1]!, `y${i}`)).status === 200) ok2++
  assert.equal(ok2, 25)
})

test('guards: yourself, guests, empty, too long, other people’s images, unknown people', async () => {
  const a = await member(), b = await member(), g = await member()
  resetRateLimits()
  assert.equal((await send(a, a, 'me')).status, 400)
  assert.equal((await send(a, b, '   ')).status, 400)
  assert.equal((await send(a, b, 'x'.repeat(2001))).status, 400)
  assert.equal((await send(a, { handle: 'nobody_here_zz' }, 'hi')).status, 404)
  await run('INSERT INTO uploads (name, user_id, data, created_at) VALUES (?, ?, ?, ?)', ['bimg_1x1.png', b.id, new Uint8Array([1]), Date.now()])
  assert.equal((await send(a, b, '', { image: '/uploads/bimg_1x1.png' })).status, 400)
  await run('INSERT INTO uploads (name, user_id, data, created_at) VALUES (?, ?, ?, ?)', ['aimg_1x1.png', a.id, new Uint8Array([1]), Date.now()])
  const img = await send(a, b, '', { image: '/uploads/aimg_1x1.png' })
  assert.equal(img.status, 200); assert.equal(img.body.message.image, '/uploads/aimg_1x1.png')
  // a guest (no wallet, x or email linked) gets the link sheet, and can't be messaged either
  await run(`UPDATE users SET extras = '{"guest":1}' WHERE id = ?`, [g.id])
  await run("DELETE FROM user_wallets WHERE user_id = ? AND kind IN ('linked', 'privy')", [g.id])
  const gs = await send(g, b, 'hi from a guest')
  assert.equal(gs.status, 403); assert.equal(gs.body.code, 'link_required')
  const tg = await send(a, g, 'hi guest')
  assert.equal(tg.status, 403)
  assert.equal((await thread(a, g)).body.canMessage, false)
})

test('text is stored as plain text: markup stays literal, control characters go', async () => {
  assert.equal(cleanText('  hi\u0000 there\u202e \r\n\r\n\r\n\r\n\r\nok  '), 'hi there \n\n\nok')
  const a = await member(), b = await member()
  resetRateLimits()
  const m = await send(a, b, '<img src=x onerror=alert(1)> <script>alert(1)</script>')
  assert.equal(m.body.message.text, '<img src=x onerror=alert(1)> <script>alert(1)</script>')
})

test('tip in a chat: records the tip once and shows a tip bubble for both sides', async () => {
  const a = await member(), b = await member()
  resetRateLimits()
  assert.equal((await call('POST', `/api/dms/${b.handle}/tip`, { body: { amount: 100 }, cookie: a.cookie })).status, 400)
  const hash = '0x' + 'ab'.repeat(32)
  const t = await call('POST', `/api/dms/${b.handle}/tip`, { body: { amount: 100, txHash: hash }, cookie: a.cookie })
  assert.equal(t.status, 200, JSON.stringify(t.body))
  assert.equal(t.body.message.kind, 'tip'); assert.equal(t.body.message.tip.amount, 100); assert.equal(t.body.message.tip.verified, false)
  assert.equal((await call('POST', `/api/dms/${b.handle}/tip`, { body: { amount: 100, txHash: hash }, cookie: a.cookie })).status, 409)
  const tip = await one<{ drop_id: string | null; to_id: number }>('SELECT drop_id, to_id FROM tips WHERE tx_hash = ?', [hash])
  assert.equal(tip!.drop_id, null); assert.equal(Number(tip!.to_id), b.id)
  const tb = await thread(b, a)
  assert.equal(tb.body.items[0].kind, 'tip'); assert.equal(tb.body.items[0].mine, false)
  // not proven onchain (no contract here): the bubble shows as pending and no "tipped you" goes out
  assert.equal(await one("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'tip'", [b.id]), undefined)
})

test('live: the stream pushes new messages to the other side', async () => {
  const a = await member(), b = await member()
  resetRateLimits()
  const ctl = new AbortController()
  const res = await app.request('http://localhost:5173/api/dms/stream', { headers: { host: 'localhost:5173', cookie: b.cookie }, signal: ctl.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const until = async (re: RegExp) => {
    const end = Date.now() + 5000
    while (!re.test(buf) && Date.now() < end) {
      const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>(ok => setTimeout(() => ok({ done: true, value: undefined }), 1000))])
      if (r.value) buf += dec.decode(r.value)
    }
    return re.test(buf)
  }
  assert.ok(await until(/event: ready/), 'ready')
  await send(a, b, 'live hello')
  assert.ok(await until(/live hello/), buf)
  const ev = JSON.parse(buf.split('\n').find(l => l.startsWith('data: {'))!.slice(6))
  assert.equal(ev.type, 'msg'); assert.equal(ev.peer, a.handle); assert.equal(ev.message.mine, false)
  ctl.abort(); await reader.cancel().catch(() => {})
})
