/**
 * X handle → numeric X id for the tip sheet's "any x account" tab. Order: people already on wifly who signed in with X
 * (id from Privy's verified token), then the X API v2 users/by/username endpoint when X_BEARER_TOKEN is set. Without
 * the token only wifly-known handles resolve and the api says so (x_off); it never guesses an id.
 * Cached (hits 24h, misses 10 min) and rate-limited per user, per ip and in total so a bad actor can't burn the X quota.
 */
import type { Hono } from 'hono'
import type { Env } from './auth'
import { needUser } from './auth'
import { clientIp } from './abuse'
import { one } from './db'
import { rateLimit } from './util'
import { Lru } from './lru'

export type XAccount = { xUserId: string; handle: string; name: string; avatar: string | null; onWifly: boolean }
type Hit = { ok: true; acct: XAccount } | { ok: false; code: 'no_such_account' }

const HIT_MS = 24 * 3600_000, MISS_MS = 10 * 60_000
const cache = new Lru<string, Hit>({ max: 5000, ttlMs: HIT_MS })
export function clearXLookupCache() { cache.clear(); globalHits.length = 0 }

type XFetch = (url: string, init: RequestInit) => Promise<Response>
let xFetch: XFetch = (u, i) => fetch(u, i)
export function setXFetchForTests(f: XFetch | null) { xFetch = f ?? ((u, i) => fetch(u, i)); clearXLookupCache() }

/** "@Name", "x.com/name", "https://twitter.com/name?s=1" → "name"; null when it can't be an X handle. */
export function normHandle(raw: string): string | null {
  let h = raw.trim()
  h = h.replace(/^(https?:\/\/)?(www\.|mobile\.)?(x|twitter)\.com\//i, '').replace(/[/?#].*$/, '').replace(/^@/, '')
  return /^[A-Za-z0-9_]{1,15}$/.test(h) ? h.toLowerCase() : null
}

const GLOBAL_MAX = 250, GLOBAL_MS = 15 * 60_000
const globalHits: number[] = []
function globalOk() {
  const now = Date.now()
  while (globalHits.length && globalHits[0] < now - GLOBAL_MS) globalHits.shift()
  if (globalHits.length >= GLOBAL_MAX) return false
  globalHits.push(now); return true
}

const ERR = {
  bad_handle: [400, 'that doesn’t look like an x handle'],
  x_off: [503, 'x lookup isn’t switched on yet, so only x accounts already on wifly can be found'],
  x_busy: [503, 'x lookup is busy, try again in a few minutes'],
  x_down: [503, 'couldn’t reach x, try again in a moment'],
} as const

export function registerXLookup(app: Hono<Env>) {
  app.get('/api/x/lookup', async c => {
    const uid = needUser(c)
    const err = (code: keyof typeof ERR) => c.json({ error: ERR[code][1], code }, ERR[code][0])
    const h = normHandle(c.req.query('handle') ?? '')
    if (!h) return err('bad_handle')
    await rateLimit(`xl:u:${uid}`, 30, 60_000)
    await rateLimit(`xl:ip:${clientIp(c)}`, 60, 60_000)
    const cached = cache.get(h)
    const send = (r: Hit) => r.ok ? c.json(r.acct) : c.json({ error: `no x account called @${h}`, code: r.code }, 404)
    if (cached) return send(cached)

    const known = await one<{ x_user_id: string; x_username: string; name: string | null; avatar: string | null }>(
      `SELECT p.x_user_id, p.x_username, u.name, u.avatar FROM privy_accounts p JOIN users u ON u.id = p.user_id
       WHERE lower(p.x_username) = ? AND p.x_user_id IS NOT NULL AND u.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT 1`, [h])
    if (known) {
      const r: Hit = { ok: true, acct: { xUserId: known.x_user_id, handle: known.x_username.toLowerCase(), name: known.name || known.x_username, avatar: known.avatar, onWifly: true } }
      cache.set(h, r); return send(r)
    }
    const token = process.env.X_BEARER_TOKEN?.trim()
    if (!token) return err('x_off')
    if (!globalOk()) return err('x_busy')
    let res: Response
    try {
      res = await xFetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(h)}?user.fields=name,profile_image_url`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) })
    } catch { return err('x_down') }
    if (res.status === 429) return err('x_busy')
    if (!res.ok && res.status !== 404) return err('x_down')
    const body = await res.json().catch(() => null) as { data?: { id?: string; username?: string; name?: string; profile_image_url?: string } } | null
    const d = body?.data
    if (!d?.id || !/^\d{1,25}$/.test(d.id)) { const r: Hit = { ok: false, code: 'no_such_account' }; cache.set(h, r, MISS_MS); return send(r) }
    const avatar = d.profile_image_url && /^https:\/\/pbs\.twimg\.com\//.test(d.profile_image_url) ? d.profile_image_url : null
    const r: Hit = { ok: true, acct: { xUserId: d.id, handle: (d.username || h).toLowerCase(), name: d.name || d.username || h, avatar, onWifly: false } }
    cache.set(h, r); return send(r)
  })
}
