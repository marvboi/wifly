/** Pot labels: the jar is epochPot(), "paid at week close" is payablePot(). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), 'wifly-pot-')), 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
const { POT_ABI, potLine, readPot } = await import('../src/companion')
const { KEEPER_ABI } = await import('../src/keeper')

const fns = (abi: readonly { type: string; name?: string }[]) => abi.filter(x => x.type === 'function').map(x => x.name as string)
const ENDS = Date.UTC(2026, 10, 2, 0, 0, 0)

test('companion reads both epochPot (jar) and payablePot (paid at week close)', () => {
  assert.ok(fns(POT_ABI).includes('epochPot')); assert.ok(fns(POT_ABI).includes('payablePot'))
})

test('keeper only needs payablePot, not the jar', () => {
  assert.ok(fns(KEEPER_ABI).includes('payablePot')); assert.ok(!fns(KEEPER_ABI).includes('epochPot'))
})

test('pot line labels both numbers', () => {
  const s = potLine({ live: true, potWif: 1500, potUsd: null, paidAtCloseWif: 900, paidAtCloseUsd: null, endsAt: ENDS })
  assert.match(s, /^in the jar now: 1,500 wif\. paid at week close: 900 wif\./)
  assert.match(s, /the week closes mon, 02 nov 2026\.$/)
})

test('pot line adds usd when there is a price', () => {
  const s = potLine({ live: true, potWif: 10, potUsd: 2.5, paidAtCloseWif: 4, paidAtCloseUsd: 1, endsAt: ENDS })
  assert.match(s, /in the jar now: 10 wif \(about \$2\.5\)\. paid at week close: 4 wif \(about \$1\)\./)
})

test('pot line falls back to the note when not live', () => {
  assert.equal(potLine({ live: false, note: 'the weekly pot opens when the Wifly contracts go live' }), 'the weekly pot opens when the Wifly contracts go live.')
})

test('getPot: this week\'s pot is epochPot, payablePot is only paid at week close', async () => {
  const E = 10n ** 18n
  const vals: Record<string, bigint> = { epochPot: 1500n * E, payablePot: 900n * E, currentEpoch: 7n, epochEndsAt: BigInt(ENDS / 1000) }
  const seen: string[] = []
  const p = await readPot(async (fn, args) => { seen.push(fn); if (fn === 'epochEndsAt') assert.deepEqual(args, [7n]); return vals[fn] }, 2)
  assert.equal(p.potWif, 1500); assert.equal(p.paidAtCloseWif, 900)
  assert.equal(p.potUsd, 3000); assert.equal(p.paidAtCloseUsd, 1800); assert.equal(p.endsAt, ENDS)
  assert.deepEqual(seen.sort(), ['currentEpoch', 'epochEndsAt', 'epochPot', 'payablePot'])
})
