/**
 * Bot friction: Cloudflare Turnstile on sign-up, a honeypot field, per-IP / per-account rate limits,
 * a new-account cooldown on links and tips, and the capped guest (logged-out) read view.
 *
 * Env (names only, set by the operator, never in code):
 *   TURNSTILE_SECRET_KEY  server-side siteverify secret. Unset = the human check is skipped (dev keeps working).
 *   TURNSTILE_SITE_KEY    public widget key, handed to the web app by GET /api/auth/config. Unset = no widget.
 *   NEW_ACCOUNT_COOLDOWN_MIN  minutes before a new account may post links or tip (default 10, 0 turns it off).
 */
import type { Context } from 'hono'
import { one } from './db'
import { needsHandleFor } from './pending'
import { fail, rateLimit } from './util'

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
/** Logged-out visitors see this many items per list, then a "sign up to see more" card. */
export const GUEST_PREVIEW = 8

export const turnstileSiteKey = () => process.env.TURNSTILE_SITE_KEY?.trim() || null
export const turnstileEnabled = () => !!process.env.TURNSTILE_SECRET_KEY?.trim()

type Fetch = (url: string, init: { method: string; body: URLSearchParams }) => Promise<{ json(): Promise<unknown> }>
let doFetch: Fetch = (u, i) => fetch(u, i)
/** Tests swap the network call. */
export function setTurnstileFetch(f: Fetch | null) { doFetch = f ?? ((u, i) => fetch(u, i)) }

/**
 * The visitor's IP. Forwarding headers are believed only when the TCP peer is an internal hop: loopback, private,
 * CGNAT (Railway's edge, 100.64.0.0/10) or IPv6 ULA (Railway private networking, fd00::/8). Those hops overwrite the
 * headers (Caddy sets X-Real-IP and X-Forwarded-For to its {client_ip}; Railway's edge overwrites both), so a
 * client-supplied X-Forwarded-For never survives. A request straight from a public address gets its socket address
 * and every header it sent is ignored. CF-Connecting-IP is never trusted (Railway passes it through untouched).
 * No socket at all means an in-process call (tests), which is treated as internal.
 */
export function clientIp(c: Context) {
  const peer = peerAddress(c)
  if (peer !== null && !isInternal(peer)) return peer
  const real = c.req.header('x-real-ip')?.trim()
  if (real && isIp(real)) return real
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  if (xff && isIp(xff)) return xff
  return peer ?? 'local'
}

function peerAddress(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  const a = env?.incoming?.socket?.remoteAddress
  return a ? a.replace(/^::ffff:/i, '') : null
}
const isIp = (s: string) => s.length <= 45 && (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) || (/^[0-9a-f:]+$/i.test(s) && s.includes(':')))
export function isInternal(ip: string) {
  const a = ip.replace(/^::ffff:/i, '').toLowerCase()
  if (a === '::1' || a === 'localhost') return true
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a)
  if (m) {
    const x = +m[1], y = +m[2]
    return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127)
  }
  return /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a) // ULA fc00::/7, link-local fe80::/10
}

/** Siteverify the widget token. No secret set: skipped. Fails closed on a bad token or a network error. */
export async function verifyTurnstile(token: string | undefined, ip?: string) {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim()
  if (!secret) return { skipped: true }
  if (!token || token.length > 2048) fail(403, 'please finish the quick human check')
  const body = new URLSearchParams({ secret, response: token! })
  if (ip && ip !== 'local') body.set('remoteip', ip)
  let ok = false
  try { ok = !!((await (await doFetch(SITEVERIFY, { method: 'POST', body })).json()) as { success?: boolean }).success } catch { ok = false }
  if (!ok) fail(403, 'the human check didn’t pass. try again')
  return { skipped: false }
}

/** The sign-up form carries an empty, hidden `website` field. People never fill it; simple bots do. */
export function checkHoneypot(b: unknown) {
  const v = (b as { website?: unknown } | null)?.website
  if (typeof v === 'string' && v.trim() !== '') fail(400, 'sign-up didn’t go through')
}

/** New accounts: per IP and per identity (wallet address or Privy id). Called only when an account is about to be created. */
export async function signupGate(c: Context, identity: string, b: { turnstileToken?: string; website?: string }) {
  checkHoneypot(b)
  const ip = clientIp(c)
  await rateLimit(`signup:ip:${ip}`, Number(process.env.SIGNUP_PER_IP_HOUR ?? 5), 3_600_000)
  await rateLimit(`signup:id:${identity.toLowerCase()}`, 3, 3_600_000)
  await verifyTurnstile(b.turnstileToken, ip)
}

/** Posting: per account (30 / 10 min) and per IP (60 / 10 min, so many fresh accounts behind one IP still slow down). */
export async function postGate(c: Context, uid: number) {
  if (await needsHandleFor(uid)) fail(403, 'pick your @name first')
  await rateLimit(`drop:${uid}`, 30, 10 * 60_000)
  await rateLimit(`dropip:${clientIp(c)}`, 60, 10 * 60_000)
}

export const LINK_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]{2,}\.(?:com|net|org|io|xyz|app|co|gg|me|link|ly|to|dev|fi|finance|site|online|club|info|biz)\b/i
export const hasLink = (s: string) => LINK_RE.test(s)

const cooldownMs = () => Math.max(0, Number(process.env.NEW_ACCOUNT_COOLDOWN_MIN ?? 10)) * 60_000
/** New accounts wait a few minutes before posting links or tipping. */
export async function newAccountCooldown(uid: number, what: 'links' | 'tips') {
  const ms = cooldownMs()
  if (!ms) return
  const u = await one<{ created_at: number }>('SELECT created_at FROM users WHERE id = ?', [uid])
  const left = u ? Number(u.created_at) + ms - Date.now() : 0
  if (left > 0) fail(429, `new accounts can share ${what === 'links' ? 'links' : 'tips'} in ${Math.ceil(left / 60_000)} min. say hi first`)
}

/** Logged-out reads: rate-limited per IP. */
export async function guestReadGate(c: Context) {
  await rateLimit(`pub:${clientIp(c)}`, Number(process.env.GUEST_READS_PER_MIN ?? 120), 60_000)
}

/** Cap a list response for guests: first GUEST_PREVIEW items, no next page, and a flag for the "sign up to see more" card. */
export function capForGuest<T extends { items: unknown[]; next: string | null }>(r: T, uid: number | null | undefined): T & { guest?: { limit: number; more: boolean } } {
  if (uid) return r
  const more = r.items.length > GUEST_PREVIEW || !!r.next
  return { ...r, items: r.items.slice(0, GUEST_PREVIEW), next: null, guest: { limit: GUEST_PREVIEW, more } }
}
