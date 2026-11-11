import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { LOW_GAS_WEI, showEmbeddedFundLine, EMBEDDED_FUND_LINE } from '../../frontend/src/lib/payer'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

test('package and settings version is 0.12.6.13', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(src('pages/Settings.tsx'), />0\.12\.6\.13</)
  assert.doesNotMatch(src('pages/Settings.tsx'), /0\.12\.6\.1(?!\d)/)
})

test('onboarding card keeps remaining copy and the bouncy logo field', () => {
  const welcome = src('pages/Welcome.tsx')
  assert.match(welcome, /who are you\?/)
  assert.match(welcome, /display name/)
  assert.doesNotMatch(welcome, /free, and yours\./)
  assert.match(src('components/WalletProofs.tsx'), /already own a \.wif\? use it/)
  assert.match(welcome, /already have an account\?/)
  assert.match(welcome, /sign in with x or email instead/)
  assert.match(welcome, /<PlayfulMarksBg/)
  assert.doesNotMatch(src('components/HandleField.tsx'), /a–z, 0–9 and _/)
  assert.match(src('styles/app.css'), /\.playful-marks/)
})

test('onboarding 12.6.2 spacing sits on top of 12.6.1 safe-area scroll, without packing the type', () => {
  const css = src('styles/app.css')
  assert.ok(css.includes('speed.12.6.1: onboarding card'), '12.6.1 onboarding rules stay')
  assert.ok(css.includes('speed.12.6.2:'), '12.6.2 spacing rules present')
  const start = css.indexOf('speed.12.6.2:')
  const block = css.slice(start)
  assert.match(block, /\.welcome__already \{\s*display: flex/)
  assert.match(block, /flex-direction: column/)
  assert.match(block, /\.welcome__handle > \.welcome__sub/)
  assert.match(block, /\.welcome__handle \.usewif/)
  assert.match(css, /padding-left: calc\(18px \+ env\(safe-area-inset-left, 0px\)\)/)
  assert.match(css, /overflow-y: auto/)
  assert.match(css, /height: 100dvh/)
})

test('post a drop composer no longer clips the name, handle or pfp', () => {
  const css = src('styles/landing.css')
  assert.ok(css.includes('speed.12.6.2:'), '12.6.2 compose rules present')
  const start = css.indexOf('speed.12.6.2:')
  const block = css.slice(start)
  assert.match(block, /\.lp-compose \{[\s\S]*max-height: none/)
  assert.match(block, /\.lp-compose \{[\s\S]*overflow: visible/)
  assert.match(block, /\.lp-compose__who b/)
  assert.match(block, /overflow: visible/)
  assert.match(block, /text-overflow: unset/)
  assert.match(block, /\.lp-compose__top \.lp-pfp/)
  assert.match(block, /\.lp-compose__row \{ flex: none; overflow: visible/)
  // the 12.6.1 hero stage fix stays
  assert.match(css, /\.lp-stage \{ border-radius: 28px; aspect-ratio: auto; display: flex/)
  assert.match(css, /\.lp-wallet, \.lp-dropcard \{ position: relative/)
})

test('other how-it-works art panels also stop clipping on mobile', () => {
  const css = src('styles/landing.css')
  const start = css.indexOf('speed.12.6.2:')
  const block = css.slice(start)
  assert.match(block, /\.lp-art \{ overflow: visible/)
  assert.match(block, /\.lp-path, \.lp-plusart, \.lp-feeart \{ overflow: visible/)
})

test('connect wallet opens Privy for external wallets and does not create one for guests', () => {
  const bridge = src('auth/privyBridge.ts')
  assert.match(bridge, /async connectExternal\(\)/)
  assert.match(bridge, /no login, no embedded wallet/)
  const start = bridge.indexOf('async connectExternal')
  const fn = bridge.slice(start, start + 600)
  assert.match(fn, /actions!\.connectWallet\(\)/)
  assert.doesNotMatch(fn, /\.login\(/)
  assert.doesNotMatch(fn, /createOnLogin|createWallet/)
  const mount = src('auth/PrivyMount.tsx')
  // embedded wallets still only on login, not on connectWallet
  assert.match(mount, /createOnLogin: 'users-without-wallets'/)
  const connect = mount.slice(mount.indexOf('connectWallet: address'), mount.indexOf('sendTx: async'))
  assert.doesNotMatch(connect, /createOnLogin|createWallet|login\(/)
  assert.equal(existsSync(join(root, 'frontend/src/components/WalletPick.tsx')), false)
})

test('Privy app id env name is VITE_PRIVY_APP_ID; WalletConnect needs a project id', () => {
  assert.match(src('auth/privyBridge.ts'), /VITE_PRIVY_APP_ID/)
  assert.match(src('auth/PrivyMount.tsx') + src('lib/privyWallets.ts'), /VITE_WALLETCONNECT_PROJECT_ID/)
  assert.match(src('wagmi.ts'), /VITE_WALLETCONNECT_PROJECT_ID/)
})

test('embedded fund line is hidden while loading, shown when empty or below LOW_GAS_WEI, hidden once funded', () => {
  assert.equal(showEmbeddedFundLine(undefined), false)
  assert.equal(showEmbeddedFundLine(0n), true)
  assert.equal(showEmbeddedFundLine(1n), true)
  assert.equal(showEmbeddedFundLine(LOW_GAS_WEI - 1n), true)
  assert.equal(showEmbeddedFundLine(LOW_GAS_WEI), false)
  assert.equal(showEmbeddedFundLine(LOW_GAS_WEI + 1n), false)
  assert.equal(showEmbeddedFundLine(10n ** 18n), false)
  assert.equal(EMBEDDED_FUND_LINE, 'fund your embedded wallet with a little eth for gas')
  const payer = src('components/Payer.tsx')
  assert.match(payer, /showEmbeddedFundLine/)
  assert.match(payer, /fundEmbedded && <p className="small" data-testid="embedded-fund">\{EMBEDDED_FUND_LINE\}/)
  assert.doesNotMatch(payer, /o\.kind === 'embedded' && <p className="small" data-testid="embedded-fund">\{EMBEDDED_FUND_LINE\}/)
  // the paying-from row and wallet menu use the same rule, not "always for embedded"
  assert.match(payer, /showEmbeddedFundLine\(o\.kind === 'embedded' \? b\?\.eth : undefined\)/)
  assert.match(payer, /o\.kind === 'embedded' && showEmbeddedFundLine\(b\?\.eth\)/)
})
