/**
 * Connect-wallet helpers: never call the injected connector when this browser
 * has no provider (a regular phone browser, or desktop without an extension).
 * In-app wallet browsers expose window.ethereum, so injected connect stays as it is.
 * When there is no provider, connectBrowserWallet opens Privy's modal instead.
 */

type EthWindow = { ethereum?: unknown; navigator?: { userAgent?: string; maxTouchPoints?: number }; matchMedia?: (q: string) => { matches: boolean }; innerWidth?: number }

export function hasInjectedProvider(w: EthWindow = typeof window !== 'undefined' ? window : {}): boolean {
  return !!w && 'ethereum' in w && w.ethereum != null
}

type Conn = { id?: string; type?: string; name?: string }

export function isInjectedConnector(c: Conn): boolean {
  const id = (c.id ?? '').toLowerCase()
  const type = (c.type ?? '').toLowerCase()
  return id === 'injected' || type === 'injected'
}

export function isWalletConnectConnector(c: Conn): boolean {
  const id = (c.id ?? '').toLowerCase()
  const type = (c.type ?? '').toLowerCase()
  const name = (c.name ?? '').toLowerCase()
  return id === 'walletconnect' || type === 'walletconnect' || name.includes('walletconnect')
}

export function injectedConnector<T extends Conn>(connectors: readonly T[] | T[]): T | undefined {
  return connectors.find(isInjectedConnector)
}

export function walletConnectConnector<T extends Conn>(connectors: readonly T[] | T[]): T | undefined {
  return connectors.find(isWalletConnectConnector)
}
