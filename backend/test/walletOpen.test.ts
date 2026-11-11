import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  hasInjectedProvider, isInjectedConnector, injectedConnector, walletConnectConnector,
} from '../../frontend/src/lib/walletOpen'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

test('no injected provider: never treat a missing ethereum as injected', () => {
  assert.equal(hasInjectedProvider({}), false)
  assert.equal(hasInjectedProvider({ ethereum: undefined }), false)
  assert.equal(hasInjectedProvider({ ethereum: { request: () => {} } }), true)
})

test('in-app wallet browsers still look injected when window.ethereum is set', () => {
  const mm = { ethereum: { isMetaMask: true }, navigator: { userAgent: 'Mozilla/5.0 (iPhone) Mobile MetaMask' } }
  assert.equal(hasInjectedProvider(mm), true)
})

test('connector pickers find injected and walletconnect by id, not by list position', () => {
  const list = [
    { id: 'walletConnect', type: 'walletConnect', name: 'WalletConnect' },
    { id: 'injected', type: 'injected', name: 'Injected' },
  ]
  assert.equal(injectedConnector(list)?.id, 'injected')
  assert.equal(walletConnectConnector(list)?.id, 'walletConnect')
  assert.equal(injectedConnector([{ id: 'walletConnect', type: 'walletConnect', name: 'WalletConnect' }]), undefined)
  assert.equal(isInjectedConnector({ id: 'injected' }), true)
})

test('connectBrowserWallet opens Privy\'s picker first, even with an injected extension; injected is a last resort when Privy is off; never login or wagmi WalletConnect', () => {
  const helper = src('lib/connectBrowserWallet.ts')
  assert.match(helper, /if \(privyEnabled\)/)
  assert.match(helper, /privyBridge\.connectExternal/)
  assert.match(helper, /hasInjectedProvider\(\)/)
  assert.match(helper, /injectedConnector/)
  assert.match(helper, /Never logs the user into Privy/)
  assert.doesNotMatch(helper, /\.login\(/)
  assert.doesNotMatch(helper, /createOnLogin|createWallet|useGuestAccounts/)
  assert.doesNotMatch(helper, /walletConnectConnector|isWalletConnectConnector/)
  // Privy path comes before the injected fallback
  assert.ok(helper.indexOf('privyEnabled') < helper.indexOf('hasInjectedProvider()'))
})

test('sign-in, link, welcome and the wallet chip open Privy instead of the custom sheet', () => {
  for (const rel of [
    'sheets/Sheets.tsx',
    'components/SignInForm.tsx',
    'pages/Welcome.tsx',
    'components/LinkAccounts.tsx',
    'components/WalletChip.tsx',
    'components/WalletsSection.tsx',
  ]) {
    const t = src(rel)
    assert.doesNotMatch(t, /WalletPickPanel/, rel)
    assert.doesNotMatch(t, /connectors\[0\]/, rel)
  }
  const body = src('components/SignInForm.tsx')
  assert.match(body, /connectBrowserWallet/)
  assert.doesNotMatch(body, /setPick\(true\)/)
  assert.doesNotMatch(body, /wallet provider error/i)
  assert.match(src('components/WalletChip.tsx'), /privyBridge\.connectExternal/)
  assert.match(src('components/WalletChip.tsx'), /privyEnabled/)
})

test('custom 12.6.1 wallet-pick labels are gone from the app source', () => {
  const files = [
    'lib/walletOpen.ts',
    'lib/connectBrowserWallet.ts',
    'components/WalletChip.tsx',
    'pages/Welcome.tsx',
    'sheets/Sheets.tsx',
    'components/SignInForm.tsx',
    'components/LinkAccounts.tsx',
  ]
  const blob = files.map(src).join('\n')
  assert.doesNotMatch(blob, /open in metamask/)
  assert.doesNotMatch(blob, /open in coinbase wallet/)
  assert.doesNotMatch(blob, /open in rainbow/)
  assert.doesNotMatch(blob, /open in trust/)
  assert.doesNotMatch(blob, /open this page in your wallet app/)
  assert.doesNotMatch(blob, /no wallet in this browser/)
  assert.doesNotMatch(src('lib/walletOpen.ts'), /WALLET_PICK_MOBILE_LINE/)
})

test('Privy wallet list includes named wallets plus WalletConnect registry and QR when a project id is set', () => {
  const list = src('lib/privyWallets.ts')
  const mount = src('auth/PrivyMount.tsx')
  for (const w of ['metamask', 'coinbase_wallet', 'rainbow', 'rabby_wallet', 'okx_wallet', 'zerion', 'detected_ethereum_wallets']) {
    assert.match(list, new RegExp(`'${w}'`))
  }
  assert.match(list, /wallet_connect/)
  assert.match(list, /wallet_connect_qr/)
  assert.doesNotMatch(list, /wallet_connect_qr_solana/)
  assert.match(list, /VITE_WALLETCONNECT_PROJECT_ID/)
  assert.match(mount, /PRIVY_WALLET_LIST/)
  assert.match(mount, /walletList: WALLETS/)
  assert.match(mount, /walletConnectCloudProjectId/)
  // no Reown AppKit / custom picker
  assert.doesNotMatch(src('lib/connectBrowserWallet.ts') + mount, /createAppKit|@reown\/appkit|WalletPickPanel/)
})
