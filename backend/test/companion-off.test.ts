// spending off (AGENT_READY false): the companion's my agent and daily cap tabs show one calm card, panel copy lowercase
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../../frontend/src/companion/Companion.tsx', import.meta.url), 'utf8')
const code = src.split('\n').filter(l => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n')

test('spending off: my agent and daily cap show the calm card, not the cap controls', () => {
  assert.match(code, /view === 'mine' && !AGENT_READY && <SpendingOff \/>/)
  assert.match(code, /view === 'cap' && !AGENT_READY && <SpendingOff \/>/)
  assert.match(code, /view === 'mine' && AGENT_READY && \(/, 'my agent pane only when spending is on')
  assert.match(code, /view === 'cap' && AGENT_READY && \(/, 'cap slider, setAgent step and turn on only when spending is on')
  assert.match(code, /signedIn && AGENT_READY && <Meters/, 'deposit / cap meters hidden while spending is off')
  assert.match(code, /title="spending is off for now" body="chat works, and you’ll set a daily cap here when it opens\."/)
})

test('companion panel copy is lowercase', () => {
  assert.match(code, />free ai assistant</)
  assert.match(code, /`plus · agent \$\{AGENT_READY && st\?\.enabled \? 'on' : 'off'\}`/)
  for (const w of ['WIF', 'ETH', 'UTC', 'Plus', 'AI']) assert.ok(!new RegExp(`['"\`>][^'"\`<]*\\b${w}\\b`).test(code), `no "${w}" in panel copy`)
})
