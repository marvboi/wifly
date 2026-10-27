// Security headers for the web app. One source for `vite preview` (vite.config.ts) and production (Caddyfile, checked
// by `npm run check:csp`). Follows Privy's CSP guide (docs.privy.io/security/implementation-guide/content-security-policy)
// plus our own origins: same-origin /api (SSE price stream included), the Robinhood Chain RPC, and Cloudflare Turnstile
// in case Privy's captcha is switched on. Re-test login after every Privy SDK upgrade.
import { createHash } from 'node:crypto'
import { THEME_INIT } from './theme-init.mjs'

/** CSP hash of the inline no-flash theme script (theme-init.mjs). The only inline script; no 'unsafe-inline'. */
export const THEME_INIT_HASH = `'sha256-${createHash('sha256').update(THEME_INIT).digest('base64')}'`

export const RPC_ORIGIN = 'https://rpc.mainnet.chain.robinhood.com'

// Our own hosts (landing + app + the Railway URL). They go in frame-ancestors and connect-src so the two hosts can talk
// to each other. In production Caddy fills them from the SITE_ORIGINS env var at start-up (space-separated), falling
// back to these defaults; the request's own host is always covered by 'self'. No localhost anywhere.
export const DEFAULT_SITE_ORIGINS = ['https://wifly.fun', 'https://app.wifly.fun', 'https://wifly-web-production.up.railway.app']
export const CADDY_SITE_ORIGINS = `{$SITE_ORIGINS:${DEFAULT_SITE_ORIGINS.join(' ')}}`
export const siteOrigins = (env = {}) => {
  const raw = env.SITE_ORIGINS || [env.VITE_SITE_URL, env.VITE_APP_URL].filter(Boolean).join(' ')
  const list = raw.split(/[\s,]+/).map(o => o.trim().replace(/\/+$/, '')).filter(o => /^https?:\/\//.test(o))
  return list.length ? list : DEFAULT_SITE_ORIGINS
}

export const BASE_CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'", THEME_INIT_HASH, 'https://challenges.cloudflare.com'],
  'style-src': ["'self'", "'unsafe-inline'"],
  // Wallet icons in the Privy / WalletConnect lists and X avatars are remote https images.
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'font-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'child-src': ['https://auth.privy.io', 'https://verify.walletconnect.com', 'https://verify.walletconnect.org'],
  'frame-src': ['https://auth.privy.io', 'https://verify.walletconnect.com', 'https://verify.walletconnect.org', 'https://challenges.cloudflare.com'],
  'connect-src': ["'self'", 'https://auth.privy.io', 'wss://relay.walletconnect.com', 'wss://relay.walletconnect.org', 'wss://www.walletlink.org',
    'https://*.rpc.privy.systems', 'https://explorer-api.walletconnect.com', 'https://pulse.walletconnect.org', 'https://api.web3modal.org', RPC_ORIGIN],
  'worker-src': ["'self'", 'blob:'],
  'manifest-src': ["'self'"],
  'media-src': ["'self'", 'blob:'],
}

/** Full directive set for a list of our own origins (or the Caddy env placeholder). */
export const cspDirectives = (origins) => ({
  ...BASE_CSP_DIRECTIVES,
  'frame-ancestors': ["'self'", ...origins],
  'connect-src': [...BASE_CSP_DIRECTIVES['connect-src'], ...origins],
})
export const cspFor = (origins) => Object.entries(cspDirectives(origins)).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ')

/** For `vite preview`: origins from the shell env, defaults otherwise. */
export const CSP_DIRECTIVES = cspDirectives(siteOrigins(typeof process === 'undefined' ? {} : process.env))
export const CSP = cspFor(siteOrigins(typeof process === 'undefined' ? {} : process.env))
/** What the Caddyfile must contain, placeholder included (checked by `npm run check:csp`). */
export const CADDY_CSP = cspFor([CADDY_SITE_ORIGINS])

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  // frame-ancestors above is what browsers use; the legacy header only allows same-origin.
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
}
