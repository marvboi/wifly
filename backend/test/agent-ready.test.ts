// agent spending on: the cap pane uses the server's signer address (build address as fallback), never shows the
// "not configured" error once either is set, and blocks a mismatch; the shared key goes through one nonce manager + queue
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const cmp = readFileSync(new URL('../../frontend/src/companion/Companion.tsx', import.meta.url), 'utf8')
const signer = readFileSync(new URL('../src/agent/signer.ts', import.meta.url), 'utf8')
const cfg = readFileSync(new URL('../../frontend/src/config.ts', import.meta.url), 'utf8')

test('AGENT_READY needs the contract, tx switch and agent address', () => {
  assert.match(cfg, /export const AGENT_READY = LIVE && TX_ENABLED && !!WIFLY_AGENT_ADDRESS/)
})

test('cap pane: real setAgent flow with the signer address, no red error once configured', () => {
  assert.match(cmp, /const agentAddr = st\.agentAddress \?\? WIFLY_AGENT_ADDRESS \?\? null/)
  assert.match(cmp, /plans\.setAgent\(agentAddr as/)
  assert.match(cmp, /disabled=\{busy \|\| cap <= 0 \|\| \(st\.live && \(!agentAddr \|\| mismatch\)\)/, 'turn on is disabled instead of erroring when no address')
  assert.ok(!cmp.includes('set by the team at launch'))
  assert.match(cmp, /view === 'cap' && AGENT_READY && \(signedIn \? st \? <CapSheet/)
})

test('one key for agent, keeper and dca keeper: shared viem nonceManager and a per-address send queue', async () => {
  assert.match(signer, /privateKeyToAccount\(pk, \{ nonceManager \}\)/)
  assert.match(signer, /sendQueue\.get\(key\)/)
  const { envSigner } = await import('../src/agent/signer')
  process.env.T_A = '0x' + '11'.repeat(32)
  const a = envSigner('T_A', 't1')!, b = envSigner('T_A', 't2')!
  assert.equal(a.address, b.address)
})
