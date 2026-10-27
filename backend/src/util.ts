import { RATE_MAX_HITS, store } from './cache'
import { randomBytes } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
export function newId(len = 10) {
  const b = randomBytes(len)
  let s = ''
  for (let i = 0; i < len; i++) s += B62[b[i] % 62]
  return s
}
export const fail = (status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 501 | 502 | 503, message: string): never => {
  throw new HTTPException(status, { message })
}
export const TAG_RE = /(^|[^\w&])#([a-z][a-z0-9_]{0,39})/gi
export const MENTION_RE = /(^|[^\w@])@([a-z0-9_]{3,20})/gi
export function extractTags(text: string) {
  return [...new Set([...text.matchAll(TAG_RE)].map(m => m[2].toLowerCase()))].slice(0, 10)
}
export function extractMentions(text: string) {
  return [...new Set([...text.matchAll(MENTION_RE)].map(m => m[2].toLowerCase()))].slice(0, 10)
}
export const charCount = (s: string) => [...s].length

/** Opaque base64url JSON cursors. */
export const encCursor = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
export function decCursor<T>(s: string | undefined | null): T | null {
  if (!s) return null
  try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as T } catch { return fail(400, 'bad cursor') }
}

/** Rate limit shared across replicas (Redis when REDIS_URL is set, memory otherwise). */
/** A key's hit log keeps RATE_MAX_HITS entries, so counts top out at RATE_MAX_HITS + 1: a limit at or above that could
 *  never trip. Env-driven limits (SIGNUP_PER_IP_HOUR=1000, a typo'd GUEST_READS_PER_MIN) are clamped to the cap, and a
 *  limit that isn't a number fails closed to the cap instead of `hits > NaN` (never true). */
export function effectiveLimit(max: number): number {
  if (!Number.isFinite(max)) return RATE_MAX_HITS
  return Math.min(Math.max(0, Math.floor(max)), RATE_MAX_HITS)
}
export async function rateLimit(key: string, max: number, windowMs: number) {
  if ((await store.hit(key, windowMs)) > effectiveLimit(max)) fail(429, 'slow down a little')
}
export function resetRateLimits() { store.reset() }
