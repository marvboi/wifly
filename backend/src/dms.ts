/**
 * Direct messages. One thread per pair (lo_id < hi_id). Each side has a member row: accepted (0 = it sits in their
 * requests because they don't follow the sender and haven't replied), last_read (read receipts) and last_at (inbox order).
 * Delete is for yourself only (dm_hidden). Blocks hide the thread both ways and stop sends. Live updates go out over SSE
 * through the shared pub/sub store (any replica), and the client falls back to polling when the stream drops.
 */
import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Env } from './auth'
import { needUser } from './auth'
import { all, one, run } from './db'
import { store } from './cache'
import { fail, rateLimit, decCursor, encCursor, charCount } from './util'
import { clientIp, hasLink, newAccountCooldown } from './abuse'
import { needsHandleFor } from './pending'
import { isGuestAccount } from './accounts'
import { hydrateUsers, type ApiUser } from './hydrate'
import { verifyTip } from './verify'

export const DM_CHARS = 2000
const PAGE = 30
const INBOX_PAGE = 20
/** pending messages a sender can stack up before the other side accepts or replies */
const REQUEST_CAP = 5
const NEW_MS = () => Math.max(0, Number(process.env.DM_NEW_ACCOUNT_HOURS ?? 24)) * 3_600_000
const now = () => Date.now()

export type ApiMessage = { id: number; mine: boolean; kind: 'text' | 'tip'; text: string; image: string | null; tip: { amount: number; txHash: string | null; verified: boolean } | null; at: number }
type MsgRow = { id: number; thread_id: number; sender_id: number; kind: string; body: string; image: string | null; meta: string; created_at: number }

function toMsg(r: MsgRow, viewer: number, verified?: boolean): ApiMessage {
  let meta: { amount?: number; txHash?: string | null; tipId?: number } = {}
  try { meta = JSON.parse(r.meta || '{}') } catch { /* keep */ }
  return {
    id: Number(r.id), mine: Number(r.sender_id) === viewer, kind: r.kind === 'tip' ? 'tip' : 'text', text: r.body ?? '', image: r.image ?? null,
    tip: r.kind === 'tip' ? { amount: Number(meta.amount ?? 0), txHash: meta.txHash ?? null, verified: !!verified } : null, at: Number(r.created_at),
  }
}
async function tipVerified(rows: MsgRow[]): Promise<Map<number, boolean>> {
  const ids = rows.filter(r => r.kind === 'tip').map(r => { try { return Number(JSON.parse(r.meta).tipId) } catch { return 0 } }).filter(Boolean)
  if (!ids.length) return new Map()
  const v = await all<{ id: number; verified: number }>(`SELECT id, verified FROM tips WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
  const by = new Map(v.map(t => [Number(t.id), !!Number(t.verified)]))
  return new Map(rows.filter(r => r.kind === 'tip').map(r => { let id = 0; try { id = Number(JSON.parse(r.meta).tipId) } catch { /* */ } return [Number(r.id), by.get(id) ?? false] }))
}

/** text as sent: no control characters except newlines, trimmed, at most three blank lines in a row */
export function cleanText(s: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\n{4,}/g, '\n\n\n').trim()
}

export async function blockedEither(a: number, b: number): Promise<'you' | 'them' | null> {
  const r = await all<{ user_id: number }>('SELECT user_id FROM blocks WHERE (user_id = ? AND target_id = ?) OR (user_id = ? AND target_id = ?)', [a, b, b, a])
  if (r.some(x => Number(x.user_id) === a)) return 'you'
  if (r.length) return 'them'
  return null
}
async function peerOf(handle: string): Promise<{ id: number; handle: string }> {
  const u = await one<{ id: number; handle: string }>('SELECT id, handle FROM users WHERE handle = ? COLLATE NOCASE AND deleted_at IS NULL', [handle.replace(/^@/, '')])
  if (!u) fail(404, 'no one here by that name')
  return { id: Number(u!.id), handle: String(u!.handle) }
}
const pair = (a: number, b: number) => (a < b ? [a, b] : [b, a])
async function threadOf(a: number, b: number) {
  const [lo, hi] = pair(a, b)
  return one<{ id: number }>('SELECT id FROM dm_threads WHERE lo_id = ? AND hi_id = ?', [lo, hi])
}
async function member(thread: number, uid: number) {
  return one<{ accepted: number; last_read: number }>('SELECT accepted, last_read FROM dm_members WHERE thread_id = ? AND user_id = ?', [thread, uid])
}
const follows = async (a: number, b: number) => !!(await one('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?', [a, b]))

/** unread threads: inbox (accepted) and requests. A blocked or deleted peer doesn't count. */
export async function dmUnread(uid: number): Promise<{ inbox: number; requests: number }> {
  const rows = await all<{ accepted: number; n: number }>(`SELECT m.accepted, COUNT(*) AS n FROM dm_members m JOIN users u ON u.id = m.peer_id AND u.deleted_at IS NULL
    WHERE m.user_id = ? AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = m.user_id AND b.target_id = m.peer_id) OR (b.user_id = m.peer_id AND b.target_id = m.user_id))
    AND EXISTS (SELECT 1 FROM dm_messages x WHERE x.thread_id = m.thread_id AND x.sender_id <> m.user_id AND x.id > m.last_read
      AND NOT EXISTS (SELECT 1 FROM dm_hidden h WHERE h.user_id = m.user_id AND h.message_id = x.id))
    GROUP BY m.accepted`, [uid])
  let inbox = 0, requests = 0
  for (const r of rows) { if (Number(r.accepted)) inbox = Number(r.n); else requests = Number(r.n) }
  return { inbox, requests }
}

type Live = { type: 'msg'; peer: string; message: ApiMessage } | { type: 'read'; peer: string; upTo: number } | { type: 'typing'; peer: string } | { type: 'hide'; peer: string; id: number } | { type: 'block'; peer: string }
const chan = (uid: number) => `dm:${uid}`
const push = (uid: number, ev: Live) => store.publish(chan(uid), JSON.stringify(ev)).catch(() => {})

async function sendGate(c: Context<Env>, uid: number, peer: { id: number }) {
  if (peer.id === uid) fail(400, 'you can’t message yourself')
  if (await needsHandleFor(uid)) fail(403, 'pick your @name first')
  const b = await blockedEither(uid, peer.id)
  if (b === 'you') fail(403, 'you blocked this account. unblock to send a message')
  if (b === 'them') fail(403, 'you can’t message this account')
  if (await isGuestAccount(peer.id)) fail(403, 'they can’t get messages yet')
  const u = await one<{ created_at: number }>('SELECT created_at FROM users WHERE id = ?', [uid])
  const fresh = !!u && now() - Number(u.created_at) < NEW_MS()
  // stricter for new accounts: fewer messages and fewer new conversations
  await rateLimit(`dm:${uid}`, fresh ? 20 : 120, 10 * 60_000)
  await rateLimit(`dmip:${clientIp(c)}`, 300, 10 * 60_000)
  return { fresh }
}

/** find or open the thread; returns ids and whether this message opens it */
async function ensureThread(uid: number, peer: number, fresh: boolean) {
  const t = await threadOf(uid, peer)
  if (t) return Number(t.id)
  await rateLimit(`dmnew:${uid}`, fresh ? 5 : 50, 24 * 3_600_000)
  const [lo, hi] = pair(uid, peer)
  const peerAccepts = (await follows(peer, uid)) ? 1 : 0
  await run('INSERT OR IGNORE INTO dm_threads (lo_id, hi_id, created_at, last_at) VALUES (?, ?, ?, ?)', [lo, hi, now(), now()])
  const id = Number((await one<{ id: number }>('SELECT id FROM dm_threads WHERE lo_id = ? AND hi_id = ?', [lo, hi]))!.id)
  await run('INSERT OR IGNORE INTO dm_members (thread_id, user_id, peer_id, accepted, last_read, last_at) VALUES (?, ?, ?, 1, 0, ?)', [id, uid, peer, now()])
  await run('INSERT OR IGNORE INTO dm_members (thread_id, user_id, peer_id, accepted, last_read, last_at) VALUES (?, ?, ?, ?, 0, ?)', [id, peer, uid, peerAccepts, now()])
  return id
}

async function postMessage(thread: number, uid: number, peer: number, kind: 'text' | 'tip', body: string, image: string | null, meta: object) {
  const t = now()
  const r = await run('INSERT INTO dm_messages (thread_id, sender_id, kind, body, image, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [thread, uid, kind, body, image, JSON.stringify(meta), t])
  const id = Number(r.lastInsertRowid)
  await run('UPDATE dm_threads SET last_at = ? WHERE id = ?', [t, thread])
  // replying is accepting; sending also marks everything before it as read for you
  await run('UPDATE dm_members SET accepted = 1, last_at = ?, last_read = ? WHERE thread_id = ? AND user_id = ?', [t, id, thread, uid])
  await run('UPDATE dm_members SET last_at = ? WHERE thread_id = ? AND user_id = ?', [t, thread, peer])
  return (await one<MsgRow>('SELECT * FROM dm_messages WHERE id = ?', [id]))!
}

async function broadcast(row: MsgRow, sender: { id: number; handle: string }, peer: { id: number; handle: string }, verified = false) {
  await push(peer.id, { type: 'msg', peer: sender.handle, message: toMsg(row, peer.id, verified) })
  await push(sender.id, { type: 'msg', peer: peer.handle, message: toMsg(row, sender.id, verified) })
}

async function ownUpload(url: unknown, uid: number): Promise<boolean> {
  if (typeof url !== 'string' || !/^\/uploads\/[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/.test(url)) return false
  return !!(await one('SELECT 1 FROM uploads WHERE name = ? AND user_id = ?', [url.slice(9), uid]))
}

type InboxItem = { peer: ApiUser; last: ApiMessage | null; unread: number; at: number; request: boolean }

export function registerDms(app: Hono<Env>) {
  // live: one stream per tab. pings keep proxies open; it ends after a while and the browser reconnects (fresh auth check).
  app.get('/api/dms/stream', c => {
    const uid = needUser(c)
    c.header('cache-control', 'no-store')
    return streamSSE(c, async s => {
      let alive = true
      const off = store.subscribe(chan(uid), m => { void s.writeSSE({ event: 'dm', data: m }).catch(() => { alive = false }) })
      s.onAbort(() => { alive = false; off() })
      await s.writeSSE({ event: 'ready', data: '1', retry: 3000 })
      const until = now() + 10 * 60_000
      let lastPing = now()
      while (alive && !s.aborted && now() < until) {
        await s.sleep(1000)
        if (!alive || s.aborted) break
        if (now() - lastPing >= 20_000) { lastPing = now(); await s.writeSSE({ event: 'ping', data: String(lastPing) }).catch(() => { alive = false }) }
      }
      off()
    })
  })

  app.get('/api/dms/unread', async c => {
    const uid = needUser(c)
    c.header('cache-control', 'no-store')
    return c.json(await dmUnread(uid))
  })

  app.get('/api/dms', async c => {
    const uid = needUser(c)
    c.header('cache-control', 'no-store')
    const tab = c.req.query('tab') === 'requests' ? 0 : 1
    const cur = decCursor<{ at: number; id: number }>(c.req.query('cursor'))
    const rows = await all<{ thread_id: number; peer_id: number; accepted: number; last_read: number; last_at: number }>(
      `SELECT m.thread_id, m.peer_id, m.accepted, m.last_read, m.last_at FROM dm_members m JOIN users u ON u.id = m.peer_id AND u.deleted_at IS NULL
       WHERE m.user_id = ? AND m.accepted = ?
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = m.user_id AND b.target_id = m.peer_id) OR (b.user_id = m.peer_id AND b.target_id = m.user_id))
       AND EXISTS (SELECT 1 FROM dm_messages x WHERE x.thread_id = m.thread_id AND NOT EXISTS (SELECT 1 FROM dm_hidden h WHERE h.user_id = m.user_id AND h.message_id = x.id))
       ${cur ? 'AND (m.last_at < ? OR (m.last_at = ? AND m.thread_id < ?))' : ''}
       ORDER BY m.last_at DESC, m.thread_id DESC LIMIT ?`,
      cur ? [uid, tab, cur.at, cur.at, cur.id, INBOX_PAGE + 1] : [uid, tab, INBOX_PAGE + 1])
    const page = rows.slice(0, INBOX_PAGE)
    const peers = await hydrateUsers(page.map(r => Number(r.peer_id)), uid)
    const items: InboxItem[] = []
    for (const r of page) {
      const p = peers.get(Number(r.peer_id)); if (!p) continue
      const last = await one<MsgRow>(`SELECT * FROM dm_messages x WHERE thread_id = ? AND NOT EXISTS (SELECT 1 FROM dm_hidden h WHERE h.user_id = ? AND h.message_id = x.id) ORDER BY id DESC LIMIT 1`, [r.thread_id, uid])
      const un = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM dm_messages x WHERE thread_id = ? AND sender_id <> ? AND id > ?
        AND NOT EXISTS (SELECT 1 FROM dm_hidden h WHERE h.user_id = ? AND h.message_id = x.id) LIMIT 99)`, [r.thread_id, uid, r.last_read, uid])
      items.push({ peer: p, last: last ? toMsg(last, uid) : null, unread: Number(un?.n ?? 0), at: Number(r.last_at), request: !Number(r.accepted) })
    }
    const lastRow = page[page.length - 1]
    const next = rows.length > INBOX_PAGE && lastRow ? encCursor({ at: Number(lastRow.last_at), id: Number(lastRow.thread_id) }) : null
    return c.json({ items, next, unread: await dmUnread(uid) })
  })

  app.get('/api/blocks', async c => {
    const uid = needUser(c)
    const rows = await all<{ target_id: number }>('SELECT target_id FROM blocks WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', [uid])
    const us = await hydrateUsers(rows.map(r => Number(r.target_id)), uid)
    return c.json({ items: rows.map(r => us.get(Number(r.target_id))).filter(Boolean) })
  })

  app.delete('/api/dms/messages/:id', async c => {
    const uid = needUser(c)
    const id = Number(c.req.param('id'))
    const m = await one<MsgRow>('SELECT * FROM dm_messages WHERE id = ?', [Number.isInteger(id) ? id : -1])
    if (!m || Number(m.sender_id) !== uid) fail(404, 'that message isn’t yours')
    await run('INSERT OR IGNORE INTO dm_hidden (user_id, message_id) VALUES (?, ?)', [uid, id])
    const t = await one<{ peer_id: number }>('SELECT peer_id FROM dm_members WHERE thread_id = ? AND user_id = ?', [m!.thread_id, uid])
    const p = t ? await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [t.peer_id]) : undefined
    if (p) await push(uid, { type: 'hide', peer: String(p.handle), id })
    return c.json({ ok: true })
  })

  app.get('/api/dms/:handle', async c => {
    const uid = needUser(c)
    c.header('cache-control', 'no-store')
    const peer = await peerOf(c.req.param('handle'))
    const pu = (await hydrateUsers([peer.id], uid)).get(peer.id)!
    const blocked = await blockedEither(uid, peer.id)
    const t = await threadOf(uid, peer.id)
    const meM = t ? await member(Number(t.id), uid) : undefined
    const peerM = t ? await member(Number(t.id), peer.id) : undefined
    const peerGuest = await isGuestAccount(peer.id)
    const base = { peer: pu, blocked, canMessage: !blocked && peer.id !== uid && !peerGuest, request: !!meM && !Number(meM.accepted), pending: !!peerM && !Number(peerM.accepted) }
    if (!t || blocked === 'them') return c.json({ ...base, items: [], next: null, peerRead: 0 })
    const before = Number(c.req.query('before') || 0)
    const rows = await all<MsgRow>(`SELECT * FROM dm_messages x WHERE thread_id = ? ${before > 0 ? 'AND id < ?' : ''}
      AND NOT EXISTS (SELECT 1 FROM dm_hidden h WHERE h.user_id = ? AND h.message_id = x.id) ORDER BY id DESC LIMIT ?`,
      before > 0 ? [t.id, before, uid, PAGE + 1] : [t.id, uid, PAGE + 1])
    const page = rows.slice(0, PAGE)
    const v = await tipVerified(page)
    const items = page.reverse().map(r => toMsg(r, uid, v.get(Number(r.id))))
    return c.json({ ...base, items, next: rows.length > PAGE ? String(items[0]!.id) : null, peerRead: Number(peerM?.last_read ?? 0), myRead: Number(meM?.last_read ?? 0) })
  })

  app.post('/api/dms/:handle', async c => {
    const uid = needUser(c)
    const peer = await peerOf(c.req.param('handle'))
    const { fresh } = await sendGate(c, uid, peer)
    const b = await c.req.json<{ text?: string; image?: string | null }>().catch(() => ({} as { text?: string; image?: string | null }))
    const text = cleanText(b.text)
    if (charCount(text) > DM_CHARS) fail(400, `messages are up to ${DM_CHARS} characters`)
    const image = b.image ? String(b.image) : null
    if (image && !(await ownUpload(image, uid))) fail(400, 'image must be uploaded first')
    if (!text && !image) fail(400, 'say something first')
    if (hasLink(text)) await newAccountCooldown(uid, 'links')
    const thread = await ensureThread(uid, peer.id, fresh)
    const pm = await member(thread, peer.id)
    if (pm && !Number(pm.accepted)) {
      const n = await one<{ n: number }>('SELECT COUNT(*) AS n FROM dm_messages WHERE thread_id = ? AND sender_id = ?', [thread, uid])
      if (Number(n?.n ?? 0) >= REQUEST_CAP) fail(429, 'wait for them to accept your request')
    }
    const me = (await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [uid]))!
    const row = await postMessage(thread, uid, peer.id, 'text', text, image, {})
    await broadcast(row, { id: uid, handle: String(me.handle) }, peer)
    return c.json({ message: toMsg(row, uid) })
  })

  /** a tip sent from the chat: the WIF already moved onchain (tip flow); this records it and drops a tip bubble in the thread */
  app.post('/api/dms/:handle/tip', async c => {
    const uid = needUser(c)
    const peer = await peerOf(c.req.param('handle'))
    const { fresh } = await sendGate(c, uid, peer)
    await rateLimit(`tip:${uid}`, 60, 60_000)
    await newAccountCooldown(uid, 'tips')
    const { amount, txHash } = await c.req.json<{ amount: number; txHash?: string }>()
    const a = Number(amount)
    if (!Number.isFinite(a) || a <= 0 || a > 1e9) fail(400, 'bad amount')
    if (!/^0x[0-9a-f]{64}$/i.test(String(txHash ?? ''))) fail(400, 'bad tx hash')
    const hash = String(txHash).toLowerCase()
    // the onchain tip sweep may have recorded (and notified) this hash first: reuse that row, only add the bubble
    const had = await one<{ id: number }>('SELECT id FROM tips WHERE tx_hash = ? AND from_id = ? AND to_id = ? ORDER BY id LIMIT 1', [hash, uid, peer.id])
    if (had && await one(`SELECT 1 FROM dm_messages WHERE kind = 'tip' AND json_extract(meta, '$.tipId') = ?`, [Number(had.id)])) fail(409, 'that tip is already here')
    // recorded as pending; verifyTip below (or the verifier sweep later) sends the one notification once it is proven onchain
    if (!had) await run('INSERT INTO tips (from_id, to_id, drop_id, amount, tx_hash, verified, created_at) VALUES (?, ?, NULL, ?, ?, 0, ?)', [uid, peer.id, a, hash, now()])
    const tip = had ?? (await one<{ id: number }>('SELECT id FROM tips WHERE from_id = ? AND tx_hash = ? ORDER BY id DESC LIMIT 1', [uid, hash]))!
    const thread = await ensureThread(uid, peer.id, fresh)
    const me = (await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [uid]))!
    const row = await postMessage(thread, uid, peer.id, 'tip', '', null, { amount: a, txHash: hash, tipId: Number(tip.id) })
    const verified = await verifyTip(Number(tip.id)).catch(() => false)
    await broadcast(row, { id: uid, handle: String(me.handle) }, peer, verified)
    return c.json({ message: toMsg(row, uid, verified), verified })
  })

  app.post('/api/dms/:handle/read', async c => {
    const uid = needUser(c)
    const peer = await peerOf(c.req.param('handle'))
    const t = await threadOf(uid, peer.id); if (!t) return c.json({ ok: true, upTo: 0 })
    const max = await one<{ id: number | null }>('SELECT MAX(id) AS id FROM dm_messages WHERE thread_id = ?', [t.id])
    const upTo = Number(max?.id ?? 0)
    const r = await run('UPDATE dm_members SET last_read = ? WHERE thread_id = ? AND user_id = ? AND last_read < ?', [upTo, t.id, uid, upTo])
    // receipts stay quiet: no receipt goes out while the thread is still a request
    const meM = await member(Number(t.id), uid)
    if (r.rowsAffected && meM && Number(meM.accepted) && !(await blockedEither(uid, peer.id))) {
      const me = (await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [uid]))!
      await push(peer.id, { type: 'read', peer: String(me.handle), upTo })
    }
    return c.json({ ok: true, upTo })
  })

  app.post('/api/dms/:handle/accept', async c => {
    const uid = needUser(c)
    const peer = await peerOf(c.req.param('handle'))
    const t = await threadOf(uid, peer.id); if (!t) fail(404, 'no request from them')
    await run('UPDATE dm_members SET accepted = 1 WHERE thread_id = ? AND user_id = ?', [t!.id, uid])
    return c.json({ ok: true })
  })

  app.post('/api/dms/:handle/typing', async c => {
    const uid = needUser(c)
    const peer = await peerOf(c.req.param('handle'))
    await rateLimit(`dmtype:${uid}`, 40, 60_000)
    const t = await threadOf(uid, peer.id)
    const pm = t ? await member(Number(t.id), peer.id) : undefined
    if (pm && Number(pm.accepted) && !(await blockedEither(uid, peer.id))) {
      const me = (await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [uid]))!
      await push(peer.id, { type: 'typing', peer: String(me.handle) })
    }
    return c.json({ ok: true })
  })

  app.post('/api/dms/:handle/report', async c => {
    const uid = needUser(c)
    const peer = await peerOf(c.req.param('handle'))
    if (peer.id === uid) fail(400, 'that’s you')
    await rateLimit(`report:${uid}`, 20, 3_600_000)
    const b = await c.req.json<{ reason?: string; note?: string; messageId?: number }>().catch(() => ({} as { reason?: string; note?: string; messageId?: number }))
    const reason = ['spam', 'abuse', 'scam', 'other'].includes(String(b.reason)) ? String(b.reason) : 'other'
    let mid: number | null = null
    if (b.messageId) {
      const t = await threadOf(uid, peer.id)
      const m = t ? await one<{ id: number }>('SELECT id FROM dm_messages WHERE id = ? AND thread_id = ? AND sender_id = ?', [Number(b.messageId), t.id, peer.id]) : undefined
      if (m) mid = Number(m.id)
    }
    await run('INSERT INTO reports (reporter_id, target_id, message_id, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [uid, peer.id, mid, reason, cleanText(b.note).slice(0, 500) || null, now()])
    return c.json({ ok: true })
  })

  app.post('/api/users/:handle/block', async c => {
    const uid = needUser(c)
    const peer = await peerOf(c.req.param('handle'))
    if (peer.id === uid) fail(400, 'you can’t block yourself')
    await run('INSERT OR IGNORE INTO blocks (user_id, target_id, created_at) VALUES (?, ?, ?)', [uid, peer.id, now()])
    const me = (await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [uid]))!
    await push(uid, { type: 'block', peer: peer.handle })
    await push(peer.id, { type: 'block', peer: String(me.handle) })
    return c.json({ ok: true, blocked: true })
  })
  app.delete('/api/users/:handle/block', async c => {
    const uid = needUser(c)
    const peer = await peerOf(c.req.param('handle'))
    await run('DELETE FROM blocks WHERE user_id = ? AND target_id = ?', [uid, peer.id])
    const me = (await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [uid]))!
    await push(uid, { type: 'block', peer: peer.handle })
    await push(peer.id, { type: 'block', peer: String(me.handle) })
    return c.json({ ok: true, blocked: false })
  })
}
