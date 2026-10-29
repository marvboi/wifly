/** 11.8.4: guest sign-in never sits on a spinner (frontend/src/lib/deadline). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeadlineError, GUEST_SIGNIN_MS, SIGNIN_SLOW_MSG, SIWE_STEP_MS, AFTER_SIGNIN_MS, calmTimeout, deadlineSignal, withDeadline } from '../../frontend/src/lib/deadline'

test('a step that never answers is cut off with the calm lowercase message', async () => {
  const t0 = Date.now()
  await assert.rejects(withDeadline(new Promise(() => {}), 40), (e: unknown) => e instanceof DeadlineError && (e as Error).message === SIGNIN_SLOW_MSG)
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(SIGNIN_SLOW_MSG, SIGNIN_SLOW_MSG.toLowerCase())
})

test('a fast answer or a real error passes straight through', async () => {
  assert.equal(await withDeadline(Promise.resolve('me'), 1000), 'me')
  await assert.rejects(withDeadline(Promise.reject(new Error('nope')), 1000), /nope/)
})

test('a sign-in that hangs then gets retried: the busy flag always clears, and the retry can succeed', async () => {
  let busy: string | null = null, line: string | null = null, signedIn = false
  const attempt = async (signIn: () => Promise<string>) => {
    busy = 'guest'; line = null
    try { await withDeadline(signIn(), 30); signedIn = true }
    catch (e) { line = e instanceof DeadlineError ? SIGNIN_SLOW_MSG : (e as Error).message }
    finally { busy = null }
  }
  await attempt(() => new Promise(() => {}))
  assert.equal(busy, null, 'buttons re-enable'); assert.equal(line, SIGNIN_SLOW_MSG); assert.equal(signedIn, false)
  await attempt(async () => 'ok')
  assert.equal(busy, null); assert.equal(line, null); assert.equal(signedIn, true)
})

test('a fetch cut off by its deadline signal reads as the calm timeout', async () => {
  const s = deadlineSignal(20)
  await new Promise(r => setTimeout(r, 60))
  assert.ok(s.aborted)
  assert.ok(calmTimeout(Object.assign(new Error('x'), { name: 'TimeoutError' })) instanceof DeadlineError)
  const other = new Error('server said no')
  assert.equal(calmTimeout(other), other)
  assert.ok(GUEST_SIGNIN_MS > SIWE_STEP_MS && SIWE_STEP_MS > AFTER_SIGNIN_MS)
})
