/** 11.8.6: the wallet dropdown redesign (avatar, pills, gas chip, tappable rows) and a readable paying-from row on the dark agent card. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOW_GAS_WEI, addrLabel, avatarColors, gasChip, wifNumber, wifUsd } from '../../frontend/src/lib/payer'

const FE = join(import.meta.dirname, '../../frontend/src')
const src = (p: string) => readFileSync(join(FE, p), 'utf8')
const E = 10n ** 18n
const A = '0x7a1100000000000000000000000000000000_1ced'.replace('_', '')
const B = '0x9ccf00000000000000000000000000000000e1bd'

test('avatarColors: stable per address, case-insensitive, distinct between wallets', () => {
  assert.deepEqual(avatarColors(A), avatarColors(A))
  assert.deepEqual(avatarColors(A.toUpperCase().replace('0X', '0x')), avatarColors(A))
  assert.notDeepEqual(avatarColors(A), avatarColors(B))
  for (const c of avatarColors(A)) assert.match(c, /^hsl\(/)
})

test('gasChip: unknown, empty ("add eth"), low (amber) and ok (green), all lowercase', () => {
  assert.equal(gasChip(undefined).tone, 'unknown')
  assert.deepEqual(gasChip(0n), { tone: 'empty', label: 'add eth' })
  assert.equal(gasChip(LOW_GAS_WEI - 1n).tone, 'low')
  assert.match(gasChip(LOW_GAS_WEI - 1n).label, /^low gas · .* eth$/)
  assert.equal(gasChip(LOW_GAS_WEI).tone, 'ok')
  assert.equal(gasChip(2n * E / 1000n).label, '0.002 eth for gas')
  for (const v of [undefined, 0n, 1n, E]) assert.equal(gasChip(v).label, gasChip(v).label.toLowerCase())
})

test('wifNumber and wifUsd: a bare number, and ≈ $ only with a live price and a non-zero balance', () => {
  assert.equal(wifNumber(5000n * E), '5,000')
  assert.equal(wifUsd(5000n * E, undefined), undefined)
  assert.equal(wifUsd(5000n * E, 0), undefined)
  assert.equal(wifUsd(0n, 0.001), undefined)
  assert.equal(wifUsd(undefined, 0.001), undefined)
  assert.ok(Math.abs((wifUsd(5000n * E, 0.0011) ?? 0) - 5.5) < 1e-9)
})

test('addrLabel never renders blank: short form, or a dash for a bad value', () => {
  assert.equal(addrLabel(A), '0x7a11…1ced')
  for (const bad of ['', undefined, null, '0x123', 'nope']) assert.equal(addrLabel(bad as unknown as string), '—')
})

test('wallet dropdown: get $wif primary, quiet disconnect, tappable rows with a check, all lowercase', () => {
  const chip = src('components/WalletChip.tsx'); const payer = src('components/Payer.tsx')
  assert.match(chip, /wm-primary[^>]*>[\s\S]{0,80}get \$wif/)
  assert.match(chip, /className="wm-quiet"[\s\S]{0,200}disconnect/)
  assert.doesNotMatch(chip, />[^<{]*\bWIF\b/)
  assert.doesNotMatch(chip + payer, /use this wallet|use another wallet/)
  assert.match(payer, /role="radio" aria-checked=\{active\}/)
  assert.match(payer, /className="wm-check"/)
  assert.match(payer, /<GasPill /)
  assert.doesNotMatch(payer, />[^<{]*\bWIF\b/)
})

test('paying-from: one row with the address (never blank), pill, copy icon and a switch that opens the wallet menu', () => {
  const payer = src('components/Payer.tsx')
  assert.match(payer, /data-testid="payer-addr">\{addrLabel\(o\.address\)\}/)
  assert.match(payer, /<CopyAddr address=\{o\.address\} iconOnly \/>/)
  assert.match(payer, /data-testid="payer-switch" onClick=\{openWalletMenu\}>switch</)
})

test('dark agent card: the payer row gets light tokens (working card in both themes, every hero in dark theme)', () => {
  const css = src('styles/app.css')
  assert.match(css, /:is\(\.agent-hero:not\(\.is-off\), \[data-theme="dark"\] \.agent-hero, \.on-dark\) \.payer \{[^}]*--ink: #F4F2EC/)
  assert.match(css, /\.payer__addr \{[^}]*color: var\(--ink\)/)
})
