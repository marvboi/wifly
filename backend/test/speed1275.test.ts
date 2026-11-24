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

test('privacy names trusted services in general, not each vendor', () => {
  const legal = src('pages/Legal.tsx')
  const parties = legal.match(/id: 'parties', title: 'who else sees data',[\s\S]*?id: 'delete'/)?.[0] ?? ''
  assert.match(parties, /we use a few trusted services to run wifly, like sign-in, wallet connection, hosting and the in-app assistant\. they only get what they need to do their job\./)
  assert.match(parties, /we don’t sell your data/)
  assert.doesNotMatch(parties, /to run the service we use:/)
  assert.doesNotMatch(parties, /each of those has its own privacy policy/)
  assert.doesNotMatch(parties, /privy|walletconnect|turnstile|openrouter|railway|z\.ai|experiential labs/i)
})

test('privacy page does not mention ip addresses', () => {
  const legal = src('pages/Legal.tsx')
  assert.match(legal, /logs are written without full wallet addresses, emails or tokens/)
  assert.match(legal, /we don’t run a third-party analytics product/)
  assert.doesNotMatch(legal, /ip address/i)
  assert.doesNotMatch(legal, /short-lived memory or redis/)
})

test('terms of use text is unchanged', () => {
  const legal = src('pages/Legal.tsx')
  const terms = legal.match(/const terms: Section\[\] = \[[\s\S]*?const privacy: Section\[\] =/)?.[0] ?? ''
  assert.match(terms, /don’t use bots, automation, scripts or scraping/)
  assert.match(terms, /provided as is/)
  assert.match(terms, /we can change these terms/)
})
