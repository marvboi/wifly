/**
 * Host split. One build serves two hosts:
 *   VITE_SITE_URL (e.g. https://wifly.fun)     -> the landing page at "/"; every app path redirects to the app host
 *   VITE_APP_URL  (e.g. https://app.wifly.fun) -> the app at the root: "/" is the feed, "/home" redirects to "/"
 * Any other host (the Railway URL, localhost), or a build without both vars, keeps the single-host layout:
 * "/" is the landing page and the feed lives at "/home".
 */
const clean = (u?: string) => (u ?? '').trim().replace(/\/+$/, '')
const hostOf = (u: string) => { try { return new URL(u).host.toLowerCase() } catch { return '' } }

export const SITE_URL = clean(import.meta.env.VITE_SITE_URL)
export const APP_URL = clean(import.meta.env.VITE_APP_URL)
const SITE_HOST = hostOf(SITE_URL)
const APP_HOST = hostOf(APP_URL)

export type HostRole = 'site' | 'app' | 'single'
export function roleFor(here: string): HostRole {
  if (!SITE_HOST || !APP_HOST || SITE_HOST === APP_HOST) return 'single'
  const h = here.toLowerCase()
  return h === APP_HOST ? 'app' : h === SITE_HOST || h === `www.${SITE_HOST}` ? 'site' : 'single'
}
export const HOST_ROLE: HostRole = roleFor(typeof window !== 'undefined' ? window.location.host : '')

/** Where the feed lives on this host. */
export const FEED_PATH = HOST_ROLE === 'app' ? '/' : '/home'

/** In-app path for this host ("/home" becomes "/" on the app host). */
export function appPath(path: string) {
  if (HOST_ROLE === 'app' && (path === '/home' || path.startsWith('/home?') || path.startsWith('/home#'))) return '/' + path.slice(5)
  return path
}

/** Link target for an app route. On the main host it points at the app host (full URL); elsewhere it stays in-app. */
export function appHref(path: string): { href: string; external: boolean } {
  if (HOST_ROLE === 'site') {
    const p = path === '/home' ? '/' : path.startsWith('/home') ? path.slice(5) || '/' : path
    return { href: `${APP_URL}${p}`, external: true }
  }
  return { href: appPath(path), external: false }
}
