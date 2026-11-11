import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { USE_WIF_PLACEMENT } from '../../frontend/src/lib/onboardWifPlacement'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

test('package and settings version is 0.12.6.13', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(src('pages/Settings.tsx'), />0\.12\.6\.13</)
  assert.doesNotMatch(src('pages/Settings.tsx'), /0\.12\.6\.4/)
})

test('shipped default is footer placement A; one constant flips to B', () => {
  assert.equal(USE_WIF_PLACEMENT, 'a')
  const place = src('lib/onboardWifPlacement.ts')
  assert.match(place, /export const USE_WIF_PLACEMENT: 'a' \| 'b' = 'a'/)
  const welcome = src('pages/Welcome.tsx')
  assert.match(welcome, /USE_WIF_PLACEMENT/)
  assert.match(welcome, /wifPlace === 'a' && useWifBtn/)
  assert.match(welcome, /wifPlace === 'b' && useWifBtn/)
  assert.match(welcome, /welcome__card--wif-\$\{wifPlace\}/)
})

test('wording is unchanged and the .wif control is no longer between the field and continue by default', () => {
  const welcome = src('pages/Welcome.tsx')
  assert.match(src('components/WalletProofs.tsx'), /already own a \.wif\? use it/)
  assert.match(welcome, /already have an account\?/)
  assert.match(welcome, /sign in with x or email instead/)
  assert.match(welcome, /<PlayfulMarksBg/)
  assert.match(welcome, /InfoTip|UseMyWif/)
  // default A: UseMyWif lives in the footer group under continue, not in the handle block alone
  const handleStart = welcome.indexOf('className="welcome__handle"')
  const altStart = welcome.indexOf('className="welcome__alt"')
  const continueBtn = welcome.indexOf('btn--dark btn--lg btn--block')
  assert.ok(handleStart > 0 && altStart > continueBtn && continueBtn > handleStart)
  const handleBlock = welcome.slice(handleStart, welcome.indexOf('btn--dark btn--lg btn--block'))
  // option B may be referenced in the handle block, but the default placement A is rendered in welcome__alt after continue
  const altBlock = welcome.slice(altStart, altStart + 800)
  assert.match(altBlock, /wifPlace === 'a' && useWifBtn/)
  assert.match(altBlock, /welcome__already/)
  assert.match(handleBlock, /wifPlace === 'b' && useWifBtn/)
  assert.doesNotMatch(handleBlock, /wifPlace === 'a' && useWifBtn/)
})

test('12.6.5 CSS covers footer group A and right-aligned field helper B', () => {
  const css = src('styles/app.css')
  assert.ok(css.includes('speed.12.6.5:'), '12.6.5 placement rules present')
  const block = css.slice(css.indexOf('speed.12.6.5:'))
  assert.match(block, /\.welcome__alt \{/)
  assert.match(block, /flex-direction: column/)
  assert.match(block, /align-items: center/)
  assert.match(block, /\.welcome__card--wif-a \.welcome__alt \.usewif--compact/)
  assert.match(block, /\.welcome__card--wif-b \.welcome__handle \.usewif--compact/)
  assert.match(block, /justify-content: flex-end/)
})
