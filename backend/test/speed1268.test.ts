import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PRIVY_WALLET_LIST } from '../../frontend/src/lib/privyWallets'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

test('package and settings version is 0.12.6.13', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(src('pages/Settings.tsx'), />0\.12\.6\.13</)
  assert.doesNotMatch(src('pages/Settings.tsx'), /0\.12\.6\.9/)
})

test('Privy picker lists named wallets, detected extensions, and WalletConnect registry/QR when an id is set', () => {
  for (const w of ['metamask', 'coinbase_wallet', 'rainbow', 'rabby_wallet', 'okx_wallet', 'zerion', 'uniswap', 'detected_ethereum_wallets'] as const) {
    assert.ok(PRIVY_WALLET_LIST.includes(w), w)
  }
  // Trust is not a dedicated Privy entry; it is reached through the registry
  assert.equal((PRIVY_WALLET_LIST as string[]).includes('trust'), false)
  assert.equal((PRIVY_WALLET_LIST as string[]).includes('trust_wallet'), false)
  const list = src('lib/privyWallets.ts')
  assert.match(list, /wallet_connect/)
  assert.match(list, /wallet_connect_qr/)
  assert.match(src('auth/PrivyMount.tsx'), /walletList: WALLETS/)
  assert.match(src('auth/PrivyMount.tsx'), /PRIVY_WALLET_LIST/)
  assert.match(src('auth/PrivyMount.tsx'), /walletConnectCloudProjectId/)
  // connectWallet (no address) passes the same list, not a single-entry override
  const mount = src('auth/PrivyMount.tsx')
  const connect = mount.slice(mount.indexOf('connectWallet: address'), mount.indexOf('sendTx: async'))
  assert.match(connect, /walletList: WALLETS/)
  assert.doesNotMatch(connect, /walletList: \['wallet_connect'\]/)
})

test('every general connect path opens Privy\'s modal; an injected extension is not a bypass', () => {
  const helper = src('lib/connectBrowserWallet.ts')
  assert.ok(helper.indexOf('if (privyEnabled)') < helper.indexOf('hasInjectedProvider()'))
  assert.match(helper, /privyBridge\.connectExternal/)
  assert.doesNotMatch(helper, /walletConnectConnector|isWalletConnectConnector|showQrModal/)
  const chip = src('components/WalletChip.tsx')
  assert.match(chip, /privyEnabled \? \(/)
  assert.match(chip, /privyBridge\.connectExternal/)
  // no longer maps every wagmi connector (that used to call WalletConnect directly and deep-link)
  assert.doesNotMatch(chip, /connectors\.map/)
  const payer = src('components/Payer.tsx')
  assert.match(payer, /if \(privyEnabled\) got = await privyBridge\.connectExact/)
  const proofs = src('components/WalletProofs.tsx')
  assert.match(proofs, /if \(privyEnabled\) \{\s*a = await privyBridge\.connectExternal/)
  const blob = helper + chip + payer + proofs + src('auth/PrivyMount.tsx') + src('pages/Welcome.tsx')
  assert.doesNotMatch(blob, /createAppKit|@reown\/appkit|AppKit/)
})

test('signed-out /welcome renders the existing sign-up card instead of redirecting home', () => {
  const welcome = src('pages/Welcome.tsx')
  assert.doesNotMatch(welcome, /ready && !me\) return <Navigate to="\/"/)
  assert.match(welcome, /if \(ready && !me\) return <WelcomeSignUp/)
  assert.match(welcome, /data-testid="welcome-signup"/)
  assert.match(welcome, /<SignInForm/)
  // signed-in users who already have a name still go onward
  assert.match(welcome, /me\?\.onboarded && !me\.needsHandle && !sp\.get\('step'\) && !sp\.get\('h'\)\) return <Navigate to=\{FEED_PATH\}/)
  const form = src('components/SignInForm.tsx')
  assert.match(form, /sign up or sign in/)
  assert.match(form, /i have a wallet/)
  assert.match(form, /connect a wallet/)
  assert.match(form, /try it with a guest key/)
  // guest path is still the 12.6.7 behavior
  assert.match(form, /rememberGuestBrowse\(\)/)
  assert.match(form, /guestBrowsePath\(/)
})

test('12.6.8 does not add new sign-in or welcome wording', () => {
  const form = src('components/SignInForm.tsx')
  assert.match(form, /join wifly\./)
  assert.match(form, /use X, email or a wallet\. it takes about a minute\./)
  assert.match(form, /you sign a message to prove it’s you\. nothing is sent or spent\./)
  assert.match(form, /a guest key lives in this browser only\. you can link a wallet later\./)
  assert.doesNotMatch(src('pages/Welcome.tsx'), /open in metamask|open this page in your wallet app|choose a wallet below/)
})

test('a no-key guest tap on the feed still enters the existing guest-browse UI (GuestNudge), with no new copy', () => {
  const form = src('components/SignInForm.tsx')
  const guest = form.match(/const guest = \(\) => \{[\s\S]*?\n  \}/)?.[0] ?? ''
  assert.match(guest, /rememberGuestBrowse\(\)/)
  assert.match(guest, /signalGuestBrowse\(\)/)
  assert.match(guest, /scrollTo/)
  const home = src('pages/Home.tsx')
  assert.match(home, /GUEST_BROWSE_EVENT/)
  assert.match(home, /prefersGuestBrowse/)
  assert.match(home, /data-testid="guest-browse-nudge"/)
  assert.match(home, /<GuestNudge/)
  // no new wording: the nudge is the existing "enjoying the read?" card
  assert.match(src('components/GuestWall.tsx'), /enjoying the read\?/)
  assert.doesNotMatch(form, /you are browsing as a guest|guest mode|continue as guest/)
  assert.doesNotMatch(home, /you are browsing as a guest|guest mode/)
})
