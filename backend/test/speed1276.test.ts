import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

test('package and settings version is 0.12.6.17', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.17"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.17"/)
  assert.match(src('pages/Settings.tsx'), />0\.12\.6\.17</)
})

test('privacy page does not say we store ip addresses', () => {
  const legal = src('pages/Legal.tsx')
  const privacy = legal.match(/const privacy: Section\[\] = \[[\s\S]*$/)?.[0] ?? ''
  assert.match(privacy, /logs are written without full wallet addresses, emails or tokens/)
  assert.match(privacy, /we don’t run a third-party analytics product on the site/)
  assert.doesNotMatch(privacy, /we use your ip address for rate limits and to help stop abuse/)
  assert.doesNotMatch(privacy, /\bip\b/i)
})

test('terms of use text is unchanged', () => {
  const legal = src('pages/Legal.tsx')
  const terms = legal.match(/const terms: Section\[\] = \[[\s\S]*?const privacy: Section\[\] =/)?.[0] ?? ''
  assert.match(terms, /don’t use bots, automation, scripts or scraping/)
  assert.match(terms, /provided as is/)
  assert.match(terms, /we can change these terms/)
})
