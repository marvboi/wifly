/**
 * Bot friction: Cloudflare Turnstile on sign-up, a honeypot field, per-IP / per-account rate limits,
 * a new-account cooldown on links and tips, and the capped guest (logged-out) read view.
 *
 * Env (names only, set by the operator, never in code):
 *   TURNSTILE_SECRET_KEY  server-side siteverify secret. Unset = the human check is skipped (dev keeps working).
 *   TURNSTILE_SITE_KEY    public widget key, handed to the web app by GET /api/auth/config. Unset = no widget.
 *   NEW_ACCOUNT_COOLDOWN_MIN  minutes before a new account may post links or tip (default 10, 0 turns it off).
 *   SIGNUP_UNVERIFIED_PER_IP_10MIN  sign-ups per ip per 10 min without a passing check (default 5).
 *   SIGNUP_UNVERIFIED_PER_IP_DAY    the same per day (default 20).
 *   TURNSTILE_VERIFY_TIMEOUT_MS     siteverify wait before it counts as a miss (default 3000).
 * The check never blocks sign-up: a missing / failed token or a siteverify error falls back to the per-ip limits above.
 */
import type { Context } from 'hono'
import { logEvent } from './accounts'
import { one } from './db'
import { needsHandleFor } from './pending'
import { fail, rateLimit } from './util'

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
/** Logged-out visitors see this many items per list, then a "sign up to see more" card. */
export const GUEST_PREVIEW = 8

export const turnstileSiteKey = () => process.env.TURNSTILE_SITE_KEY?.trim() || null
export const turnstileEnabled = () => !!process.env.TURNSTILE_SECRET_KEY?.trim()

type Fetch = (url: string, init: { method: string; body: URLSearchParams; signal?: AbortSignal }) => Promise<{ json(): Promise<unknown> }>
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

const envNum = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d }
export const signupLimits = () => ({ ip10m: envNum('SIGNUP_UNVERIFIED_PER_IP_10MIN', 5), ipDay: envNum('SIGNUP_UNVERIFIED_PER_IP_DAY', 20), verifyMs: envNum('TURNSTILE_VERIFY_TIMEOUT_MS', 3000) })
export const SIGNUP_BUSY_MSG = 'lots of new accounts from this network right now. try again in a few minutes.'
export const SIGNUP_DAY_MSG = 'that’s today’s new accounts from this network. try again tomorrow.'

export type HumanCheck = 'skipped' | 'passed' | 'missing' | 'failed' | 'error'
/** Siteverify the widget token. Never throws: no secret = skipped, otherwise passed / missing / failed / error (network or timeout). */
export async function verifyTurnstile(token: string | undefined, ip?: string): Promise<HumanCheck> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim()
  if (!secret) return 'skipped'
  if (!token || typeof token !== 'string' || token.length > 2048) return 'missing'
  const body = new URLSearchParams({ secret, response: token })
  if (ip && ip !== 'local') body.set('remoteip', ip)
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new Error('timeout')) }, signupLimits().verifyMs) })
    const r = await Promise.race([doFetch(SITEVERIFY, { method: 'POST', body, signal: ac.signal }).then(x => x.json()), timeout]) as { success?: boolean }
    return r?.success ? 'passed' : 'failed'
  } catch { return 'error' } finally { if (timer) clearTimeout(timer) }
}

/** The sign-up form carries an empty, hidden `website` field. People never fill it; simple bots do. */
export function checkHoneypot(b: unknown) {
  const v = (b as { website?: unknown } | null)?.website
  if (typeof v === 'string' && v.trim() !== '') fail(400, 'sign-up didn’t go through')
}

/**
 * New accounts: per IP and per identity (wallet address or Privy id). Called only when an account is about to be created.
 * The human check never blocks: without a passing token the sign-up still goes through, under tighter per-ip limits.
 */
export async function signupGate(c: Context, identity: string, b: { turnstileToken?: string; website?: string }) {
  checkHoneypot(b)
  const ip = clientIp(c)
  await rateLimit(`signup:ip:${ip}`, Number(process.env.SIGNUP_PER_IP_HOUR ?? 5), 3_600_000)
  await rateLimit(`signup:id:${identity.toLowerCase()}`, 3, 3_600_000)
  const check = await verifyTurnstile(b.turnstileToken, ip)
  if (check !== 'passed' && check !== 'skipped') {
    const l = signupLimits()
    const over = async (key: string, max: number, ms: number) => { try { await rateLimit(key, max, ms); return false } catch { return true } }
    if (await over(`signup:nv10:${ip}`, l.ip10m, 10 * 60_000)) { logEvent(`[human-check] ${check} · limited 10m`); fail(429, SIGNUP_BUSY_MSG) }
    if (await over(`signup:nvday:${ip}`, l.ipDay, 86_400_000)) { logEvent(`[human-check] ${check} · limited day`); fail(429, SIGNUP_DAY_MSG) }
  }
  if (check !== 'skipped') logEvent(`[human-check] ${check}${check === 'passed' ? '' : ' · allowed under ip limits'}`)
  return check
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
