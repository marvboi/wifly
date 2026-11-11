/** speed.12.3: bento settings is the ship candidate. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')
const FE = join(root, 'frontend/src')
const src = (r: string) => readFileSync(join(FE, r), 'utf8')

test('package version is 0.12.3 lineage (accepts 12.4 ship)', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.\d+"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.\d+"/)
})

test('dead concept A/C code is gone; bento is the page', () => {
  assert.ok(!existsSync(join(FE, 'pages/settings/ConceptA.tsx')))
  assert.ok(!existsSync(join(FE, 'pages/settings/ConceptC.tsx')))
  assert.match(src('pages/Settings.tsx'), /SettingsBento/)
  assert.doesNotMatch(src('pages/Settings.tsx'), /concept-switcher|\?concept=/)
})

test('wallets tile has live balance preview and profile tile shows face', () => {
  const b = src('pages/settings/ConceptB.tsx')
  assert.match(b, /useBalances/)
  assert.match(b, /sc-tile__wal/)
  assert.match(b, /sc-tile__face/)
  assert.match(b, /fmt\(b\?\.wif/)
})
