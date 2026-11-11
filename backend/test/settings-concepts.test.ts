/** speed.12.3: bento settings is the only settings page; every control still reachable. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const FE = join(import.meta.dirname, '../../frontend/src')
const read = (r: string) => readFileSync(join(FE, r), 'utf8')

test('settings is bento-only: no concept switcher or ?concept param', () => {
  const main = read('pages/Settings.tsx')
  const model = read('pages/settings/model.ts')
  assert.match(main, /SettingsBento/)
  assert.doesNotMatch(main, /ConceptSwitcher|concept-switcher|ConceptA|ConceptC/)
  assert.doesNotMatch(model, /useConcept|searchParams|concept=/)
  assert.ok(!existsSync(join(FE, 'pages/settings/ConceptA.tsx')))
  assert.ok(!existsSync(join(FE, 'pages/settings/ConceptC.tsx')))
})

test('bento + panels keep every control reachable', () => {
  const main = read('pages/Settings.tsx')
  const panels = read('pages/settings/Panels.tsx')
  const bento = read('pages/settings/ConceptB.tsx')
  const all = main + panels + bento
  for (const needle of [
    'AvatarPicker', 'settings-profile', 'settings-wif', 'view card', 'list for sale',
    'get a .wif', 'UseMyWif', 'login-row', 'LinkList', 'WalletsTip', 'WalletsSection',
    'TipDestination', 'ThemeToggle labeled', 'sign-out', 'settings-delete', 'delete my account',
    'InfoTip', 'RemoveAccountSheet', 'NameCard', 'wif-card',
  ]) assert.match(all, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  // live wallet preview on the tall tile
  assert.match(bento, /useBalances|sc-tile__wal|sc-tile__bals/)
  assert.match(bento, /sc-tile__face/)
})

test('settings modules exist', () => {
  const dir = join(FE, 'pages/settings')
  const files = readdirSync(dir)
  for (const f of ['ConceptB.tsx', 'Panels.tsx', 'model.ts']) assert.ok(files.includes(f), f)
})
