/** Where a no-key “try it with a guest key” tap should go. Null if already on the feed. */
export function guestBrowsePath(pathname: string, feedPath: string): string | null {
  const here = (pathname.replace(/\/+$/, '') || '/')
  const feed = (feedPath.replace(/\/+$/, '') || '/')
  return here === feed ? null : feedPath
}

/** The feed listens for this so an already-on-feed guest tap can still enter the visible guest-browse state. */
export const GUEST_BROWSE_EVENT = 'wifly:guest-browse'

/** Set when the user picks guest browse. Survives a route change if the event fired before the feed mounted. */
let pendingGuestBrowse = false

export function signalGuestBrowse() {
  pendingGuestBrowse = true
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(GUEST_BROWSE_EVENT))
}

/** True if a guest-browse signal was raised (and still pending) or localStorage says so. Clears the in-memory latch. */
export function consumeGuestBrowse(flag: () => boolean = () => false): boolean {
  const pending = pendingGuestBrowse
  pendingGuestBrowse = false
  return pending || flag()
}

/** Test hook: the in-memory latch, not the storage flag. */
export function peekGuestBrowsePending() {
  return pendingGuestBrowse
}
