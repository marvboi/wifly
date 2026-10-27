/** Public URLs for people and posts. Profiles live at /@name; plain /name works when it isn't one of the app's own words. */

/** First path segments the app (or the server) owns. Keep in sync with RESERVED in backend/src/features.ts. */
export const ROUTE_WORDS = new Set([
  'home', 'search', 'notifications', 'settings', 'admin', 'api', 'uploads', 'you', 'me', 'welcome', 'login', 'signin', 'signup', 'logout',
  'messages', 'bookmarks', 'vote', 'pay', 'post', 'agent', 'plus', 'names', 'n', 'u', 'pot', 'swap', 'dca', 'deploy', 'docs',
  'followers', 'following', 'onboarding', 'guest', 'link', 'share', 'feed', 'explore', 'trending', 'drops', 'drop', 'status',
  'assets', 'brand', 'fonts', 'static', 'favicon', 'manifest', 'app', 'www', 'landing', 'tip', 'tips', 'wallet', 'auth', 'oauth',
  'callback', 'healthz', 'market', 'badges', 'burn', 'about', 'terms', 'privacy', 'help', 'support',
])
const HANDLE = /^[a-z0-9_]{3,20}$/

export const profilePath = (handle: string) => `/@${handle}`
export const followPath = (handle: string, kind: 'followers' | 'following') => `/@${handle}/${kind}`
/** A post's own page: /@author/post/id when the author is known, else the bare permalink. */
export const postPath = (id: string, author?: string | null) => author && author !== 'you' && !author.startsWith('~') ? `/@${author}/post/${id}` : `/post/${id}`

/** The handle a first path segment points at: "@name" always, "name" only when it isn't a route word. */
export function handleFromSegment(seg: string | undefined): string | null {
  if (!seg) return null
  const s = decodeURIComponent(seg)
  if (s.startsWith('@')) { const h = s.slice(1).toLowerCase(); return h === 'you' || HANDLE.test(h) ? h : null }
  const h = s.toLowerCase()
  return HANDLE.test(h) && !ROUTE_WORDS.has(h) ? h : null
}

/** Old profile links: /u/name[/rest] → /@name[/rest]. Null when the path isn't one. */
export function legacyProfileRedirect(pathname: string): string | null {
  const m = /^\/u\/([^/]+)(\/.*)?$/.exec(pathname)
  return m ? `/@${m[1]}${m[2] ?? ''}` : null
}
