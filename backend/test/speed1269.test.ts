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
  assert.doesNotMatch(src('pages/Settings.tsx'), /0\.12\.6\.9/)
})

test('signed-out /welcome full-page sign-up uses a dedicated welcome--signup shell', () => {
  const welcome = src('pages/Welcome.tsx')
  const signup = welcome.match(/function WelcomeSignUp\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(signup, /className="welcome welcome--signup"/)
  assert.match(signup, /data-testid="welcome-signup"/)
  assert.match(signup, /<SignInForm/)
  assert.match(signup, /PlayfulMarksBg/)
  // signed-in onboarding keeps the existing .welcome root (not welcome--signup)
  const main = welcome.match(/export function Welcome[\s\S]*?\n\}\n\n/)?.[0]
    ?? welcome.slice(0, welcome.indexOf('function WelcomeSignUp'))
  assert.match(main, /className="welcome"/)
  assert.doesNotMatch(main, /welcome--signup/)
})

test('full-page sign-up card is vertically centered with min padding and can scroll', () => {
  const css = src('styles/app.css')
  const block = css.slice(css.indexOf('speed.12.6.9'))
  assert.match(block, /\.welcome\.welcome--signup/)
  assert.match(block, /grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/)
  assert.match(block, /padding-top:\s*max\(24px,\s*env\(safe-area-inset-top/)
  assert.match(block, /padding-bottom:\s*max\(24px,\s*env\(safe-area-inset-bottom/)
  assert.match(block, /overflow-y:\s*auto/)
  assert.match(block, /\.welcome\.welcome--signup \.welcome__stage--signup/)
  assert.match(block, /margin-top:\s*0/)
  // phone full-page view stays centered; inner scroll if the card is taller than the viewport
  assert.match(block, /@media \(max-width: 760px\)/)
  assert.match(block, /max-height:\s*100dvh/)
})

test('centering is scoped to the full-page card, not the phone sheet or onboarding', () => {
  const css = src('styles/app.css')
  // the 1fr / auto / 1fr centering must only apply to .welcome--signup
  const rows = [...css.matchAll(/grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/g)]
  assert.equal(rows.length, 1)
  const around = css.slice(Math.max(0, rows[0].index! - 200), rows[0].index! + 80)
  assert.match(around, /\.welcome\.welcome--signup/)
  const sheet = src('sheets/Sheets.tsx')
  const signInSheet = sheet.match(/function SignInSheet[\s\S]*?\n\}/)?.[0] ?? sheet
  assert.match(signInSheet, /<SignInForm/)
  assert.doesNotMatch(signInSheet, /welcome--signup/)
})

test('12.6.9 does not change sign-in copy, env, or the guest path', () => {
  const form = src('components/SignInForm.tsx')
  assert.match(form, /join wifly\./)
  assert.match(form, /sign up or sign in/)
  assert.match(form, /i have a wallet/)
  assert.match(form, /connect a wallet/)
  assert.match(form, /try it with a guest key/)
  assert.match(form, /rememberGuestBrowse\(\)/)
  assert.match(form, /signalGuestBrowse\(\)/)
  const envExample = readFileSync(join(root, 'frontend/.env.example'), 'utf8')
  assert.doesNotMatch(src('pages/Welcome.tsx') + form, /VITE_[A-Z0-9_]+\s*=/)
  assert.match(envExample, /VITE_PRIVY_APP_ID/)
})
