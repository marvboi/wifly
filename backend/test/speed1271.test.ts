import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')
const css = () => src('styles/app.css')

test('package and settings version is 0.12.6.13', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(src('pages/Settings.tsx'), />0\.12\.6\.13</)
})

test('Turnstile stays silent and off-layout: no widget, no retry line, no console noise', () => {
  const hc = src('components/HumanCheck.tsx')
  const form = src('components/SignInForm.tsx')
  assert.match(form, /<HumanCheck \/>/)
  assert.match(hc, /className="humancheck"/)
  assert.match(hc, /aria-hidden="true"/)
  assert.match(hc, /appearance: 'interaction-only'/)
  assert.match(hc, /waitForHumanCheck/)
  assert.doesNotMatch(hc, /humancheck__retry/)
  assert.doesNotMatch(hc, /quick check is taking/)
  assert.doesNotMatch(hc, /try again/)
  assert.doesNotMatch(hc, /console\.(warn|error|log)/)
  assert.match(hc, /'error-callback': \(\) => \{ quietFail\(\); return true \}/)
  const style = css()
  assert.match(style, /\.humancheck[^{]*\{[\s\S]*?position: fixed !important/)
  assert.match(style, /\.humancheck[^{]*\{[\s\S]*?width: 0 !important/)
  assert.match(style, /\.humancheck[^{]*\{[\s\S]*?opacity: 0 !important/)
  assert.match(style, /\.humancheck[^{]*\{[\s\S]*?pointer-events: none !important/)
  assert.match(style, /\.humancheck__retry \{ display: none !important/)
  // backend still verifies tokens when present, and still allows sign-up without one (per-ip limits)
  const abuse = readFileSync(join(root, 'backend/src/abuse.ts'), 'utf8')
  assert.match(abuse, /The human check never blocks/)
  assert.match(abuse, /verifyTurnstile/)
})

test('opening Privy hands off: our sign-in sheet is hidden (not stacked) under the Privy dialog, but stays mounted so a later reject can retry', () => {
  const form = src('components/SignInForm.tsx')
  const privy = form.match(/const privy = \(\) => \{[^}]+\}/)?.[0] ?? ''
  assert.match(privy, /signInPrivy\(\)/)
  // do not unmount the sheet on open: the waiting / reject state has to stay. CSS hides it while Privy is up.
  assert.doesNotMatch(privy, /closeSheet\(\)/)
  assert.match(css(), /body:has\(#privy-dialog\) \.sheet-wrap/)
  assert.match(css(), /pointer-events: none !important/)
  const sheet = src('sheets/Sheets.tsx')
  assert.match(sheet, /Escape.*privy-dialog/)
})

test('background marks pack once and stay put; bounce and mouse-follow are kept', () => {
  const bg = src('components/PlayfulMarksBg.tsx')
  assert.match(bg, /frozen = true/)
  assert.match(bg, /if \(!frozen\) schedule/)
  assert.match(bg, /playful-marks\$\{origin \? ' is-placed' : ''\}/)
  assert.doesNotMatch(bg, /useLayoutEffect\(\(\) => \{ placeRef\.current\(\) \}\)/)
  assert.match(bg, /MutationObserver\(\(\) => \{ if \(!frozen\) schedule\(\) \}\)/)
  const style = css()
  assert.match(style, /\.playful-marks:not\(\.is-placed\) \{ visibility: hidden/)
  assert.match(style, /@keyframes playful-mark-drift/)
  assert.match(style, /\.playful-marks__react \{\s*transform: translate3d\(calc\(var\(--play-x\)/)
})

test('every guest path still browses without minting a key, and the top nudge is visible on desktop', () => {
  const form = src('components/SignInForm.tsx')
  assert.match(form, /data-testid="signin-guest"/)
  assert.match(form, /rememberGuestBrowse\(\)/)
  assert.match(form, /signalGuestBrowse\(\)/)
  assert.doesNotMatch(form, /allowSessionRestore/)
  const home = src('pages/Home.tsx')
  const browseNudge = home.match(/<div className="[^"]*" data-testid="guest-browse-nudge">/)?.[0] ?? ''
  assert.match(browseNudge, /feed__item/)
  assert.doesNotMatch(browseNudge, /feed__inline/)
})

test('12.6.11 does not change sign-in copy or env', () => {
  const form = src('components/SignInForm.tsx')
  assert.match(form, /try it with a guest key/)
  assert.match(form, /sign up or sign in/)
  assert.match(form, /i have a wallet/)
  const env = readFileSync(join(root, 'frontend/.env.example'), 'utf8')
  assert.doesNotMatch(env, /12\.6\.11/)
})
