/**
 * Human check state, no react. The check never blocks sign-in: callers wait at most HUMAN_CHECK_WAIT_MS for a token,
 * then go ahead without one (the server falls back to per-ip limits).
 */
export const HUMAN_CHECK_WAIT_MS = 3500

type Waiter = () => void
let token: string | undefined
let active = false // a widget is on the page and may still hand out a token
let failed = false // error / expired / timeout: don't make anyone wait for it
const waiters = new Set<Waiter>()
const wake = () => { for (const w of [...waiters]) w() }

export const getToken = () => token
export function setActive(on: boolean) { active = on; if (!on) { token = undefined; failed = false } wake() }
export function setToken(t: string | undefined) { token = t; if (t) failed = false; wake() }
export function setFailed(on: boolean) { failed = on; if (on) token = undefined; wake() }
/** Tokens are single use: drop it after a sign-in attempt. The widget is reset by the caller. */
export function clearToken() { token = undefined }

/** Resolves with the token, or undefined when there is no widget, it failed, or `ms` passed. Never rejects. */
export function waitForHumanCheck(ms = HUMAN_CHECK_WAIT_MS): Promise<string | undefined> {
  const ready = () => !!token || !active || failed
  if (ready()) return Promise.resolve(token)
  return new Promise(res => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done: Waiter = () => { if (!ready()) return; waiters.delete(done); if (timer) clearTimeout(timer); res(token) }
    waiters.add(done)
    timer = setTimeout(() => { waiters.delete(done); res(token) }, Math.max(0, ms))
  })
}
