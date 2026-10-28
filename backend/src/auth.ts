import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { sign, verify } from 'hono/jwt'
import { getAddress, verifyMessage, type Hex } from 'viem'
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from 'viem/siwe'
import { chainClient } from './chain'
import { ALLOWED_HOSTS, ALLOWED_ORIGINS, ALLOWED_ORIGINS_SET, COOKIE_DOMAIN, COOKIE_SECURE, SESSION_SECRET, SIWE_DOMAINS } from './config'
import { createHash, randomBytes } from 'node:crypto'
import { one, run } from './db'
import { fail } from './util'

export const COOKIE = 'wifly_session'
const SESSION_DAYS = 30
/** How this session signed in: 'wallet' = Sign-In with Ethereum (a wallet or this browser's guest key), 'privy' = X or email. */
export type LoginVia = 'wallet' | 'privy'
export type Env = { Variables: { uid: number | null; via: LoginVia | null } }

export const session: MiddlewareHandler<Env> = async (c, next) => {
  c.set('uid', null); c.set('via', null)
  const tok = getCookie(c, COOKIE)
  if (tok) {
    try {
      const p = await verify(tok, SESSION_SECRET, 'HS256')
      const id = Number(p.sub)
      // signed out on the server: a copied or late cookie stays dead
      if (await one('SELECT 1 FROM revoked_sessions WHERE tok = ?', [tokKey(tok)])) throw new Error('revoked')
      if (id && (await one('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', [id]))) { c.set('uid', id); c.set('via', p.via === 'wallet' || p.via === 'privy' ? p.via : null) }
    } catch { /* expired or tampered: treat as signed out */ }
  }
  await next()
}

export function needUser(c: Context<Env>): number {
  const id = c.get('uid')
  if (!id) fail(401, 'sign in first')
  return id!
}

/** Writes must come from our own frontend: a custom header cannot be sent by a plain cross-site form. */
export const csrf: MiddlewareHandler = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('x-wifly') !== '1') fail(403, 'missing x-wifly header')
  await next()
}

export async function issueNonce() {
  const nonce = generateSiweNonce()
  await run('DELETE FROM nonces WHERE expires_at < ?', [Date.now()])
  await run('INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)', [nonce, Date.now() + 10 * 60_000])
  return nonce
}

/** ALLOWED_ORIGINS is enforced when it is set, and always in production (default: the Railway URL). */
const enforceOrigins = () => ALLOWED_ORIGINS_SET || process.env.NODE_ENV === 'production'

function allowedDomains(c: Context) {
  if (SIWE_DOMAINS.length) return SIWE_DOMAINS
  if (enforceOrigins()) return ALLOWED_HOSTS
  // Dev: accept the host the request came through (the Vite proxy forwards the browser's host via Origin).
  const hosts = new Set<string>()
  const origin = c.req.header('origin')
  if (origin) try { hosts.add(new URL(origin).host) } catch { /* ignore */ }
  const host = c.req.header('x-forwarded-host') || c.req.header('host')
  if (host) hosts.add(host)
  return [...hosts]
}

/**
 * EOA first (ecrecover, no network). If that fails the address may be a smart account (Privy smart wallet, Safe,
 * Kernel...): ask Robinhood Chain via viem, which checks ERC-1271 isValidSignature for deployed accounts and
 * ERC-6492 wrapped signatures for accounts that are not deployed yet. Read-only eth_call, never a transaction.
 */
export async function verifySignature(address: Hex, message: string, signature: Hex): Promise<boolean> {
  if (await verifyMessage({ address, message, signature }).catch(() => false)) return true
  try { return await chainClient().verifyMessage({ address, message, signature }) } catch { return false }
}

/** Sign-in with Ethereum (EIP-4361): the wallet signs a message containing our one-time nonce. No transaction. */
export async function verifySiwe(c: Context, message: string, signature: Hex) {
  if (typeof message !== 'string' || typeof signature !== 'string' || message.length > 2000) fail(400, 'bad sign-in payload')
  const parsed = parseSiweMessage(message)
  if (!parsed.address || !parsed.nonce || !parsed.domain) fail(400, 'not a sign-in message')
  const domains = allowedDomains(c)
  if (!domains.includes(parsed.domain!)) fail(401, `sign-in message is for ${parsed.domain}, not this site`)
  if (enforceOrigins()) {
    let uriOrigin = ''
    try { uriOrigin = new URL(String(parsed.uri)).origin } catch { /* checked below */ }
    if (!ALLOWED_ORIGINS.includes(uriOrigin) || new URL(uriOrigin).host !== parsed.domain) fail(401, 'sign-in message is for another site')
  }
  const row = await one<{ used: number; expires_at: number }>('SELECT used, expires_at FROM nonces WHERE nonce = ?', [parsed.nonce!])
  if (!row || Number(row.used) || Number(row.expires_at) < Date.now()) fail(401, 'sign-in expired, try again')
  if (!validateSiweMessage({ message: parsed, nonce: parsed.nonce, domain: parsed.domain, time: new Date() })) fail(401, 'sign-in message is not valid now')
  if (!(await verifySignature(parsed.address!, message, signature))) fail(401, 'signature does not match')
  const used = await run('UPDATE nonces SET used = 1 WHERE nonce = ? AND used = 0', [parsed.nonce!])
  if (!used.rowsAffected) fail(401, 'sign-in already used')
  return getAddress(parsed.address!).toLowerCase()
}

export async function startSession(c: Context, uid: number, via: LoginVia) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400
  // sid: every sign-in gets its own token, so signing one out never touches another
  const tok = await sign({ sub: String(uid), exp, via, sid: randomBytes(9).toString('base64url') }, SESSION_SECRET, 'HS256')
  setCookie(c, COOKIE, tok, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400, ...cookieScope(c) })
}
const tokKey = (tok: string) => createHash('sha256').update(tok).digest('base64url')
/** Sign out: the token is revoked on the server (until it would have expired anyway), then the cookie is cleared. */
export async function endSession(c: Context) {
  const tok = getCookie(c, COOKIE)
  if (tok) {
    try {
      const p = await verify(tok, SESSION_SECRET, 'HS256')
      const now = Math.floor(Date.now() / 1000)
      await run('DELETE FROM revoked_sessions WHERE exp < ?', [now])
      await run('INSERT OR IGNORE INTO revoked_sessions (tok, exp) VALUES (?, ?)', [tokKey(tok), Number(p.exp) || now + SESSION_DAYS * 86400])
    } catch { /* not a valid token: nothing to revoke */ }
  }
  deleteCookie(c, COOKIE, { path: '/', ...cookieScope(c) })
}

/**
 * Session cookie scope from ALLOWED_ORIGINS: Secure whenever the request comes from an allowed https origin (or
 * COOKIE_SECURE=1), and Domain=COOKIE_DOMAIN only when the request host sits under it; otherwise host-only.
 */
function cookieScope(c: Context): { secure: boolean; domain?: string } {
  const origin = c.req.header('origin') || ''
  const host = (c.req.header('x-forwarded-host') || c.req.header('host') || '').toLowerCase().split(':')[0]
  const secure = COOKIE_SECURE || (origin.startsWith('https://') && ALLOWED_ORIGINS.includes(origin))
  const domain = COOKIE_DOMAIN && (host === COOKIE_DOMAIN || host.endsWith(`.${COOKIE_DOMAIN}`)) ? COOKIE_DOMAIN : undefined
  return domain ? { secure, domain } : { secure }
}
