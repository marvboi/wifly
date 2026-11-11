// 11.8.4b / 12.6.12: the wallet and x/email sign-in buttons can never stay greyed out.
// Wallet / Privy waits for the user to sign or reject; only guest has a 20s cap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSignInGate, stillPending, SIGNIN_CAP_MS, type SignInView } from '../../frontend/src/lib/attempt'
import { DeadlineError, SIGNIN_SLOW_LINE } from '../../frontend/src/lib/deadline'

type M = { handle: string }
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))
function harness(capMs = 40) {
  const views: SignInView[] = [], signed: M[] = []
  const g = createSignInGate<M>({ capMs, onView: v => views.push(v), onSignedIn: m => signed.push(m), quiet: e => /sign-in closed|reject/i.test((e as Error).message) })
  const deferred = () => { let res!: (m: M) => void, rej!: (e: unknown) => void; const p = new Promise<M>((a, b) => { res = a; rej = b }); return { p, res, rej } }
  return { g, views, signed, deferred, last: () => views[views.length - 1] }
}

test('cap is 20s, and only the default guest path uses it', () => { assert.equal(SIGNIN_CAP_MS, 20_000) })

test('default gate: a delayed wallet (or privy) sign stays waiting; it does not cap', async () => {
  const views: SignInView[] = [], signed: M[] = []
  const g = createSignInGate<M>({ onView: v => views.push(v), onSignedIn: m => signed.push(m) })
  let res!: (m: M) => void
  const p = new Promise<M>(a => { res = a })
  g.run('wallet', () => p)
  await tick(80)
  assert.equal(g.busy(), 'wallet')
  assert.deepEqual(views.at(-1), { busy: 'wallet', line: null })
  res({ handle: 'ok' }); await tick()
  assert.deepEqual(signed, [{ handle: 'ok' }])
  assert.deepEqual(views.at(-1), { busy: null, line: null })
})

test('cancel: buttons back at once, no line; a late failure is ignored', async () => {
  const h = harness(); const d = h.deferred()
  h.g.run('wallet', () => d.p)
  assert.deepEqual(h.last(), { busy: 'wallet', line: null })
  h.g.cancel()
  assert.deepEqual(h.last(), { busy: null, line: null })
  d.rej(new Error('boom')); await tick()
  assert.deepEqual(h.last(), { busy: null, line: null })
  assert.equal(h.signed.length, 0)
})

test('cap: after an explicit capMs the buttons come back with the try-again line', async () => {
  const h = harness(30); const d = h.deferred()
  h.g.run('privy', () => d.p)
  await tick(60)
  assert.deepEqual(h.last(), { busy: null, line: SIGNIN_SLOW_LINE })
  assert.equal(h.g.busy(), null)
})

test('late success after the cap or cancel still signs in, exactly once', async () => {
  const h = harness(20); const a = h.deferred(), b = h.deferred()
  h.g.run('wallet', () => a.p); await tick(40)           // capped (explicit capMs)
  h.g.run('wallet', () => b.p)                            // try again
  assert.equal(h.g.busy(), 'wallet')
  a.res({ handle: 'late' }); await tick()                 // the first one lands late
  assert.deepEqual(h.signed, [{ handle: 'late' }])
  assert.deepEqual(h.last(), { busy: null, line: null })   // buttons not stuck on the second attempt
  b.res({ handle: 'late' }); await tick()                 // and the second never signs in twice
  assert.equal(h.signed.length, 1)
  h.g.run('guest', () => Promise.resolve({ handle: 'x' })); await tick()
  assert.equal(h.signed.length, 1)                        // nothing runs once signed in
  const c = harness(); const d = c.deferred()
  c.g.run('privy', () => d.p); c.g.cancel(); d.res({ handle: 'c' }); await tick()
  assert.deepEqual(c.signed, [{ handle: 'c' }])            // server already made the session: finish cleanly, don't strand it
})

test('errors: closed/rejected is quiet, timeouts calm, others shown lowercase; only one attempt at a time', async () => {
  const h = harness()
  h.g.run('privy', () => Promise.reject(new Error('sign-in closed'))); await tick()
  assert.deepEqual(h.last(), { busy: null, line: null })
  h.g.run('wallet', () => Promise.reject(new Error('User rejected the request.'))); await tick()
  assert.deepEqual(h.last(), { busy: null, line: null })
  h.g.run('guest', () => Promise.reject(new DeadlineError())); await tick()
  assert.deepEqual(h.last(), { busy: null, line: SIGNIN_SLOW_LINE })
  h.g.run('wallet', () => { throw new Error('No Wallet Found') }); await tick()
  assert.deepEqual(h.last(), { busy: null, line: 'no wallet found' })
  const d = h.deferred(); let calls = 0
  h.g.run('wallet', () => { calls++; return d.p }); h.g.run('privy', () => { calls++; return d.p })
  assert.equal(calls, 1); assert.equal(h.g.busy(), 'wallet')
  h.g.cancel()
})

test('recover: still-pending wallet/privy is left alone by stillPending; recover() itself still works when called', async () => {
  assert.equal(stillPending('wallet', { authenticated: false, dialogOpen: false }), true)
  assert.equal(stillPending('privy', { authenticated: false, dialogOpen: false }), true)
  assert.equal(stillPending('privy', { authenticated: false, dialogOpen: true }), true)
  assert.equal(stillPending('privy', { authenticated: true, dialogOpen: false }), true)
  const h = harness(); const d = h.deferred()
  h.g.run('privy', () => d.p)
  h.g.recover('wallet'); assert.equal(h.g.busy(), 'privy')  // wrong kind: no-op
  h.g.recover('privy'); assert.deepEqual(h.last(), { busy: null, line: SIGNIN_SLOW_LINE })
  d.rej(new Error('late')); await tick()
  assert.deepEqual(h.last(), { busy: null, line: SIGNIN_SLOW_LINE })
})

test('the sheet wires it: cancel link, try-again line, focus + visibility recovery, no uncapped awaits', () => {
  const src = readFileSync(new URL('../../frontend/src/components/SignInForm.tsx', import.meta.url), 'utf8')
  const sheet = src
  for (const s of ['data-testid="signin-cancel"', 'data-testid="signin-retry"', "addEventListener('focus'", "addEventListener('visibilitychange'", "gate.current!.run('wallet'", "gate.current!.run('privy'", "gate.current!.run('guest'", '>cancel</button>', '>try again</button>', 'waiting for your wallet.'])
    assert.ok(sheet.includes(s), s)
  assert.ok(!/done\(await sign/.test(sheet), 'no direct uncapped awaits left')
})
