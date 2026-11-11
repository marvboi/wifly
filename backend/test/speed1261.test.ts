import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

test('hero no longer has the top “runs on $wif” eyebrow; the footer one stays', () => {
  const land = src('pages/Landing.tsx')
  assert.doesNotMatch(land, /lp-eyebrow/)
  assert.equal((land.match(/runs on \$wif/g) || []).length, 1)
  assert.match(land, /lp-foot__runs[\s\S]*runs on \$wif/)
})

test('mobile footer is a stacked grid with 44px tap targets', () => {
  const css = src('styles/landing.css')
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.lp-foot__cols \{ display: grid; grid-template-columns: 1fr 1fr/)
  assert.match(css, /\.lp-foot__cols a \{ min-height: 44px/)
})

test('mobile hero stage reflows so the dropcard is in normal flow', () => {
  const css = src('styles/landing.css')
  assert.match(css, /\.lp-stage \{ border-radius: 28px; aspect-ratio: auto; display: flex/)
  assert.match(css, /\.lp-wallet, \.lp-dropcard \{ position: relative/)
})

test('onboarding card keeps comfortable safe-area margins and scrolls on short phones', () => {
  const css = src('styles/app.css')
  const start = css.indexOf('speed.12.6.1: onboarding card')
  assert.ok(start >= 0, '12.6.1 onboarding card rules present')
  const block = css.slice(start)
  assert.match(block, /padding-left: calc\(18px \+ env\(safe-area-inset-left, 0px\)\)/)
  assert.match(block, /padding-right: calc\(18px \+ env\(safe-area-inset-right, 0px\)\)/)
  assert.match(block, /padding-top: calc\(16px \+ env\(safe-area-inset-top, 0px\)\)/)
  assert.match(block, /height: 100dvh/)
  assert.match(block, /min-height: 100svh/)
  assert.match(block, /overflow-y: auto/)
  assert.match(block, /justify-content: flex-start/)
  // the playful logo field stays
  assert.match(css, /\.playful-marks/)
  const welcome = src('pages/Welcome.tsx')
  assert.match(welcome, /<PlayfulMarksBg/)
})
