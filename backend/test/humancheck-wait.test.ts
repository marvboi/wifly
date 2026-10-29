// 11.8.3 frontend: sign-in never waits forever on turnstile. no widget = no wait, a token or a failure ends the wait, else ~3.5s cap.
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
const hc = await import('../../frontend/src/components/humanCheckState')

beforeEach(() => { hc.setActive(false) })

test('no widget on the page: resolves at once with no token', async () => {
  const t0 = Date.now()
  assert.equal(await hc.waitForHumanCheck(), undefined)
  assert.ok(Date.now() - t0 < 50)
})

test('widget stuck (invisible, no callback): goes ahead without a token after the cap', async () => {
  hc.setActive(true)
  const t0 = Date.now()
  assert.equal(await hc.waitForHumanCheck(120), undefined)
  const dt = Date.now() - t0
  assert.ok(dt >= 100 && dt < 1000, String(dt))
  assert.equal(hc.HUMAN_CHECK_WAIT_MS, 3500)
})

test('a token that arrives while waiting is used right away', async () => {
  hc.setActive(true)
  const p = hc.waitForHumanCheck(5000)
  setTimeout(() => hc.setToken('tok-1'), 20)
  const t0 = Date.now()
  assert.equal(await p, 'tok-1')
  assert.ok(Date.now() - t0 < 1000)
})

test('error / expired / timeout ends the wait with no token; a retry that passes brings the token back', async () => {
  hc.setActive(true)
  const p = hc.waitForHumanCheck(5000)
  setTimeout(() => hc.setFailed(true), 20)
  assert.equal(await p, undefined)
  assert.equal(await hc.waitForHumanCheck(5000), undefined, 'failed: no wait at all')
  hc.setFailed(false) // try again
  const q = hc.waitForHumanCheck(5000)
  setTimeout(() => hc.setToken('tok-2'), 20)
  assert.equal(await q, 'tok-2')
  hc.clearToken()
  assert.equal(hc.getToken(), undefined, 'tokens are single use')
})
