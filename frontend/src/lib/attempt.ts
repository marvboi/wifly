/**
 * 11.8.4b: one sign-in attempt at a time, and none of them can trap the sheet.
 * - cancel: ends the wait at once, buttons back.
 * - cap: after capMs the buttons come back on their own with "that took longer than it should. try again".
 * - recover: the window came back (focus / visible) and nothing is pending any more, e.g. a wallet popup or privy closed
 *   without saying so. same as the cap.
 * - a late failure from an attempt that was cancelled, capped or recovered is ignored.
 * - a late success still signs you in, exactly once (the server already made the session, so leaving the sheet open
 *   would be the broken state). two attempts that both succeed never sign in twice.
 */
import { DeadlineError, GUEST_SIGNIN_MS, SIGNIN_SLOW_LINE } from './deadline'

export type SignInKind = 'wallet' | 'guest' | 'privy'
export type SignInView = { busy: SignInKind | null; line: string | null }
export const SIGNIN_CAP_MS = GUEST_SIGNIN_MS // 20s, same cap for every way in
export const RECOVER_GRACE_MS = { wallet: 4_000, privy: 1_500, guest: 0 } as const

export function createSignInGate<M>(o: { capMs?: number; onView: (v: SignInView) => void; onSignedIn: (m: M) => void; quiet?: (e: unknown) => boolean }) {
  const capMs = o.capMs ?? SIGNIN_CAP_MS
  let seq = 0, finished = false
  let live: { id: number; kind: SignInKind; timer: ReturnType<typeof setTimeout> } | null = null
  const end = (line: string | null) => { if (live) { clearTimeout(live.timer); live = null } o.onView({ busy: null, line }) }
  const lineFor = (e: unknown) => o.quiet?.(e) ? null : e instanceof DeadlineError ? SIGNIN_SLOW_LINE : ((e as Error)?.message || SIGNIN_SLOW_LINE).toLowerCase()
  return {
    run(kind: SignInKind, fn: () => Promise<M>) {
      if (finished || live) return
      const id = ++seq
      live = { id, kind, timer: setTimeout(() => { if (live?.id === id) end(SIGNIN_SLOW_LINE) }, capMs) }
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
  if (kind === 'privy') return privy.authenticated || privy.dialogOpen // logged in (exchange running) or privy's window is open
  return kind === 'guest' // guest has no window to close; the cap covers it. a wallet popup that's gone = not pending
}
