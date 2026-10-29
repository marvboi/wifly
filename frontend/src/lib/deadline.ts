/** 11.8.4: sign-in never leaves anyone on a spinner. Every step gets a time cap; a slow step fails calmly so the buttons come back. */
export const SIWE_STEP_MS = 10_000      // nonce fetch, verify post
export const GUEST_SIGNIN_MS = 20_000   // the whole guest sign-in, human-check wait included
export const AFTER_SIGNIN_MS = 2_000    // housekeeping after the server said yes (dropping a privy session): never waited on longer
/** the in-sheet line, followed by a "try again" link */
export const SIGNIN_SLOW_LINE = 'that took longer than it should.'
export const SIGNIN_SLOW_MSG = 'that took longer than it should. check your connection and try again.'

export class DeadlineError extends Error {
  readonly code = 'timeout'
  constructor(msg = SIGNIN_SLOW_MSG) { super(msg); this.name = 'DeadlineError' }
}

/** Resolves or rejects like `p`, or rejects with a DeadlineError after `ms`. The timer is always cleared. */
export function withDeadline<T>(p: Promise<T>, ms: number, msg?: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  const cap = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new DeadlineError(msg)), ms) })
  return Promise.race([p, cap]).finally(() => clearTimeout(t))
}

/** An AbortSignal that fires after `ms` (for fetch). */
export function deadlineSignal(ms: number): AbortSignal {
  const S = AbortSignal as unknown as { timeout?: (n: number) => AbortSignal }
  if (S.timeout) return S.timeout(ms)
  const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal
}

/** A fetch that was cut off by a deadline signal reads as the calm "took too long" error; anything else passes through. */
export function calmTimeout(e: unknown): unknown {
  const n = (e as { name?: string } | null)?.name
  return n === 'TimeoutError' || n === 'AbortError' ? new DeadlineError() : e
}
