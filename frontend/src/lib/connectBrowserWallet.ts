/**
 * Open a wallet for connect / sign-in / link via Privy's own wallet picker (connect-only, never login).
 * An injected extension is one option in that list, not a shortcut that skips it.
 * Never logs the user into Privy and never creates an embedded or guest wallet.
 * When Privy is off (no app id), fall back to the injected connector only — never the wagmi
 * WalletConnect connector, which deep-links into a single wallet app.
 */
import { privyBridge, privyEnabled } from '../auth/privyBridge'
import { hasInjectedProvider, injectedConnector } from './walletOpen'

type Conn = { id?: string; type?: string; name?: string }

export async function connectBrowserWallet<C extends Conn>(opts: {
  address?: `0x${string}`
  isConnected?: boolean
  connectors: readonly C[] | C[]
  connectAsync: (args: { connector: C }) => Promise<{ accounts: readonly `0x${string}`[] }>
}): Promise<`0x${string}`> {
  if (opts.isConnected && opts.address) return opts.address
  if (privyEnabled) {
    const addr = await privyBridge.connectExternal()
    if (!addr) throw new Error('no wallet found in this browser')
    return addr as `0x${string}`
  }
  if (hasInjectedProvider()) {
    const c = injectedConnector(opts.connectors)
    if (!c) throw new Error('no wallet found in this browser')
    const addr = (await opts.connectAsync({ connector: c })).accounts[0]
    if (!addr) throw new Error('no wallet found in this browser')
    return addr
  }
  throw new Error('no wallet found in this browser')
}
