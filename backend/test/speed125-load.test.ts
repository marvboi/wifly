/** speed.12.5 load test: ~500 concurrent conversion requests, mocked upstream, one fetch per TTL. */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { getPrice, setPriceSource, resetPriceState, priceTtl, type WifPrice } from '../src/price'
import { resetRateLimits } from '../src/util'

const sample = (at = Date.now()): WifPrice => ({
  usd: 0.024, eth: 0.000008, wifPerEth: 125_000, ethUsd: 3000,
  source: { wif: 'uniswap-v4', ethUsd: 'chainlink' },
  updatedAt: at, stale: false, poolId: '0x71ef',
})

after(() => { setPriceSource(null); resetPriceState(); resetRateLimits() })

test('500 concurrent conversion requests share about one upstream call per TTL', async () => {
  const prev = process.env.PRICE_TTL_MS
  // priceTtl() floors at 1_000 ms
  process.env.PRICE_TTL_MS = '1000'
  try {
    const ttl = priceTtl()
    assert.equal(ttl, 1000)

    let calls = 0
    setPriceSource(async () => {
      calls++
      await new Promise(r => setTimeout(r, 15))
      return sample(Date.now())
    })
    resetPriceState()
    resetRateLimits()

    const t0 = Date.now()
    const warm = await getPrice()
    assert.equal(warm.usd, 0.024)
    assert.equal(calls, 1, 'cold start is one upstream read')

    const wave1 = await Promise.all(Array.from({ length: 500 }, () => getPrice()))
    assert.equal(wave1.length, 500)
    assert.ok(wave1.every(p => p.usd === 0.024))
    assert.equal(calls, 1, 'fresh TTL window: still one upstream call after 500 concurrent reads')

    await new Promise(r => setTimeout(r, ttl + 20))
    const wave2 = await Promise.all(Array.from({ length: 500 }, () => getPrice()))
    assert.equal(wave2.length, 500)
    assert.ok(wave2.every(p => p.usd === 0.024))
    // SWR: stale hits return immediately and share one background refresh
    await new Promise(r => setTimeout(r, 50))
    assert.equal(calls, 2, 'after TTL expiry, one more upstream call for the next window')

    const elapsed = Date.now() - t0
    console.log(`[speed125-load] concurrent=500 ttl_ms=${ttl} upstream_calls=${calls} elapsed_ms=${elapsed}`)
  } finally {
    if (prev === undefined) delete process.env.PRICE_TTL_MS
    else process.env.PRICE_TTL_MS = prev
  }
})
