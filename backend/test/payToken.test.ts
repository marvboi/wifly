import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FE = join(import.meta.dirname, '../../frontend/src/lib')
const payTokenSrc = () => readFileSync(join(FE, 'payToken.ts'), 'utf8')
const priceSrc = () => readFileSync(join(FE, 'price.tsx'), 'utf8')

const USDG_DECIMALS = 6
const round = (n: number, decimals: number) => Math.round(n * 10 ** decimals) / 10 ** decimals

/** Same math as `quotePayAmount` (mirrored here so tests don’t load Vite `config.ts` in Node). */
function quotePayAmount(wifAmount: number, token: 'wif' | 'usdg' | 'eth', rates: { usdPerWif: number; wifPerEth: number }) {
  if (token === 'wif') return wifAmount
  if (token === 'usdg') return round(wifAmount * rates.usdPerWif, USDG_DECIMALS)
  return round(wifAmount / rates.wifPerEth, 6)
}

const RATE = { usdPerWif: 6.3 / 8000, wifPerEth: 1_270_000 }

test('quotePayAmount: USDG tracks USD per WIF, not 1:1 WIF count', () => {
  const usdg = quotePayAmount(8000, 'usdg', RATE)
  assert.ok(Math.abs(usdg - 6.3) < 0.01, `expected ~6.3 USDG, got ${usdg}`)
})

test('quotePayAmount: eth uses wifPerEth', () => {
  const eth = quotePayAmount(8000, 'eth', RATE)
  const want = 8000 / RATE.wifPerEth
  assert.ok(Math.abs(eth - want) < 1e-6, `expected ${want} eth, got ${eth}`)
})

test('payToken.ts wires live pay rates and usdPerWif', () => {
  assert.match(payTokenSrc(), /wifAmount \* r\.usdPerWif/)
  assert.match(payTokenSrc(), /getPayRates\(\)/)
  assert.match(priceSrc(), /payRatesFromPrice/)
  assert.match(readFileSync(join(import.meta.dirname, '../../frontend/src/config.ts'), 'utf8'), /usdPerWif/)
})