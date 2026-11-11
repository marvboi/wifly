/**
 * speed.12.1 lineage carried into 12.3 bento: controls reachable via Panels,
 * save feedback / signed-out / tap targets.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FE = join(import.meta.dirname, '../../frontend/src')
const src = (rel: string) => readFileSync(join(FE, rel), 'utf8')
const settingsBundle = () =>
  src('pages/Settings.tsx') + src('pages/settings/Panels.tsx') + src('pages/settings/model.ts')
  + src('pages/settings/ConceptB.tsx')

test('settings keeps every section and control from speed.12', () => {
  const s = settingsBundle()
  for (const id of [
    'settings-profile', 'settings-wif', 'settings-links', 'settings-wallets',
    'settings-tips', 'settings-appearance', 'settings-account', 'settings-delete', 'sign-out',
  ]) assert.match(s, new RegExp(id))
  assert.match(s, /ThemeToggle labeled/)
  assert.match(s, /WalletsSection/)
  assert.match(s, /TipDestination bare/)
  assert.match(s, /LinkList/)
  assert.match(s, /ListNameButton/)
  assert.match(s, /RemoveAccountSheet/)
  assert.match(s, /AvatarPicker/)
  assert.match(s, /api\('\/me\/delete'/)
  assert.match(s, /method: 'PATCH'/)
})

test('settings profile header shows avatar, name and .wif', () => {
  const b = src('pages/settings/ConceptB.tsx')
  assert.match(b, /sc-bento__hi|sc-tile__face/)
  assert.match(b, /Mascot|avatar/)
  assert.match(settingsBundle(), /AvatarPicker/)
})

test('settings save feedback: toast + inline saved state', () => {
  const s = settingsBundle()
  assert.match(s, /toast\('saved'\)/)
  assert.match(s, /markSaved/)
  assert.match(s, /sc-save__st|set__save-status/)
  assert.match(s, /unsaved|saved/)
})

test('settings signed-out empty is intentional', () => {
  const s = src('pages/Settings.tsx')
  assert.match(s, /settings-signed-out/)
  assert.match(s, /set-out|sc-out/)
  assert.match(s, /sign in to manage your settings/)
})

test('settings rows target 44px+ taps and labeled theme sits in appearance', () => {
  const css = src('styles/app.css') + src('styles/settings-concepts.css')
  assert.match(css, /min-height: 44px|min-height: 56px|min-height: 112px/)
  assert.match(css, /\.tt--labeled/)
  assert.match(settingsBundle(), /data-testid="settings-appearance"/)
  assert.match(settingsBundle(), /ThemeToggle labeled/)
})

test('package version is 0.12.1 lineage (accepts 12.3 ship)', () => {
  const fe = readFileSync(join(FE, '../package.json'), 'utf8')
  const be = readFileSync(join(FE, '../../backend/package.json'), 'utf8')
  assert.match(fe, /"version": "0\.12\.\d+"/)
  assert.match(be, /"version": "0\.12\.\d+"/)
})
