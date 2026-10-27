/** Fee split model: every fee 90% weekly community pot / 10% burned (treasury 0); .wif claims 50% treasury / 50% pot. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLAIM_SPLIT, FEE_SPLIT, splitFee } from '../src/config'

test('every fee: 90% pot, 10% burned, nothing to the treasury', () => {
  assert.deepEqual(FEE_SPLIT, { pot: 90, burn: 10 })
  assert.deepEqual(splitFee(100), { treasury: 0, pot: 90, burn: 10 })
})

test('.wif name claims: 50% treasury, 50% pot, no burn', () => {
  assert.deepEqual(CLAIM_SPLIT, { treasury: 50, pot: 50 })
  assert.deepEqual(splitFee(1000, 'claim'), { treasury: 500, pot: 500, burn: 0 })
})

test('splits add up to the whole fee', () => {
  for (const kind of ['fee', 'claim'] as const) {
    const p = splitFee(125, kind)
    assert.equal(p.treasury + p.pot + p.burn, 125)
  }
})
