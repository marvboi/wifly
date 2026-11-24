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

test('terms and privacy pages have no em dash or en dash', () => {
  const legal = src('pages/Legal.tsx')
  assert.doesNotMatch(legal, /[\u2014\u2013]/)
  assert.match(legal, /direct messages \(text and images\) on our servers, in readable form/)
  assert.match(legal, /anything you do on-chain \(tips, votes, name claims, swaps and the like\) is public/)
  assert.match(legal, /they are not end-to-end encrypted/)
  assert.match(legal, /don’t use bots, automation, scripts or scraping/)
})
