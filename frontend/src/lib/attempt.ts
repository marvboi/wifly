/**
 * 11.8.4b / 12.6.12: one sign-in attempt at a time, and none of them can trap the sheet.
 * - cancel: ends the wait at once, buttons back.
 * - cap: guest only (20s). Wallet and Privy stay on the waiting state until the user signs,
 *   rejects, or taps cancel — a signature prompt can take longer than 20s, and a window
 *   focus/visibility change is not a dismiss.
 * - recover: still available for a caller that knows the attempt is gone; the sheet does not
 *   auto-recover a live wallet/Privy wait on focus.
 * - a late failure from an attempt that was cancelled, capped or recovered is ignored.
 * - a late success still signs you in, exactly once (the server already made the session, so leaving the sheet open
 *   would be the broken state). two attempts that both succeed never sign in twice.
 */
import { DeadlineError, GUEST_SIGNIN_MS, SIGNIN_SLOW_LINE } from './deadline'

export type SignInKind = 'wallet' | 'guest' | 'privy'
export type SignInView = { busy: SignInKind | null; line: string | null }
export const SIGNIN_CAP_MS = GUEST_SIGNIN_MS // 20s, guest only
export const RECOVER_GRACE_MS = { wallet: 4_000, privy: 1_500, guest: 0 } as const

export function createSignInGate<M>(o: { capMs?: number; onView: (v: SignInView) => void; onSignedIn: (m: M) => void; quiet?: (e: unknown) => boolean }) {
  let seq = 0, finished = false
  let live: { id: number; kind: SignInKind; timer: ReturnType<typeof setTimeout> | null } | null = null
  const end = (line: string | null) => { if (live) { if (live.timer) clearTimeout(live.timer); live = null } o.onView({ busy: null, line }) }
  const lineFor = (e: unknown) => o.quiet?.(e) ? null : e instanceof DeadlineError ? SIGNIN_SLOW_LINE : ((e as Error)?.message || SIGNIN_SLOW_LINE).toLowerCase()
  const capFor = (kind: SignInKind) => o.capMs ?? (kind === 'guest' ? SIGNIN_CAP_MS : 0)
  return {
    run(kind: SignInKind, fn: () => Promise<M>) {
      if (finished || live) return
      const id = ++seq
      const capMs = capFor(kind)
      live = { id, kind, timer: capMs > 0 ? setTimeout(() => { if (live?.id === id) end(SIGNIN_SLOW_LINE) }, capMs) : null }
      o.onView({ busy: kind, line: null })
      let p: Promise<M>
      try { p = Promise.resolve(fn()) } catch (e) { p = Promise.reject(e) }
      p.then(m => {
        if (finished) return
        finished = true
        if (live?.id === id) end(null); else if (live) end(null) // a newer attempt is waiting: it's moot now
        o.onSignedIn(m)
      }, e => { if (live?.id === id) end(lineFor(e)) })
    },
    cancel() { if (live) end(null) },
    recover(kind?: SignInKind) { if (live && (!kind || live.kind === kind)) end(SIGNIN_SLOW_LINE) },
    busy: () => live?.kind ?? null,
    attempt: () => live?.id ?? null,
    signedIn: () => finished,
  }
}

/** When the window comes back: is the attempt still really pending? */
export function stillPending(kind: SignInKind, privy: { authenticated: boolean; dialogOpen: boolean }): boolean {
  // wallet / privy: a sign-message prompt may still be open in an extension, a popup, or a mobile
  // wallet app even if this tab is focused and Privy's dialog is hidden. Stay pending until the
  // promise settles (sign, reject) or the user taps cancel.
  if (kind === 'wallet' || kind === 'privy') return true
  void privy
  return kind === 'guest'
}
