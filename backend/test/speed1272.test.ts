import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

test('package and settings version is 0.12.6.13', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(src('pages/Settings.tsx'), />0\.12\.6\.13</)
})

test('wallet and Privy sign-in wait for the signature: no default cap, focus does not drop a live wait', () => {
  const attempt = src('lib/attempt.ts')
  assert.match(attempt, /kind === 'guest' \? SIGNIN_CAP_MS : 0/)
  assert.match(attempt, /if \(kind === 'wallet' \|\| kind === 'privy'\) return true/)
  const form = src('components/SignInForm.tsx')
  assert.match(form, /waiting for your wallet\./)
  assert.match(form, /waiting for sign-in\./)
  assert.match(form, /stillPending\(/)
  assert.match(form, /connectBrowserWallet\(\{ isConnected, address, connectors, connectAsync \}\)/)
  // existing quiet reject + retry, no new copy
  assert.match(form, /sign-in closed\|reject\|denied\|cancel/)
  assert.match(form, />try again<\/button>/)
  assert.match(form, />cancel<\/button>/)
})

test('Privy open still hides our sheet (no stack) without unmounting it', () => {
  const form = src('components/SignInForm.tsx')
  const privy = form.match(/const privy = \(\) => \{[^}]+\}/)?.[0] ?? ''
  assert.match(privy, /signInPrivy\(\)/)
  assert.doesNotMatch(privy, /closeSheet\(\)/)
  const css = src('styles/app.css')
  assert.match(css, /body:has\(#privy-dialog\) \.sheet-wrap/)
  assert.match(css, /pointer-events: none !important/)
})

test('12.6.12 does not change sign-in copy, guest browse-only, or env', () => {
  const form = src('components/SignInForm.tsx')
  assert.match(form, /try it with a guest key/)
  assert.match(form, /rememberGuestBrowse\(\)/)
  assert.match(form, /signalGuestBrowse\(\)/)
  assert.doesNotMatch(form, /generatePrivateKey/)
  assert.doesNotMatch(form, /allowSessionRestore/)
  assert.match(form, /waiting for your wallet\./)
  assert.match(form, /waiting for sign-in\./)
  assert.match(src('lib/deadline.ts'), /that took longer than it should/)
})
