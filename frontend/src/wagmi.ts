import { createConfig } from 'wagmi'
import { injected, walletConnect } from 'wagmi/connectors'
import { robinhoodChain } from './config'
import { fallbackRpc } from './lib/rpc'

// Browser wallets (MetaMask, Rabby, ...) via injected/EIP-6963, plus WalletConnect when a project id is set.
// Privy wallets (embedded for X/email logins, or external ones picked in Privy's modal) sign through privyBridge.sendTx.
const WC_PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '').trim()

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [
    injected({ shimDisconnect: true }),
    ...(WC_PROJECT_ID ? [walletConnect({ projectId: WC_PROJECT_ID, showQrModal: true, metadata: { name: 'Wifly', description: 'Wifly', url: typeof location !== 'undefined' ? location.origin : 'https://wifly.app', icons: [] } })] : []),
  ],
  // fallback across public RPCs, retries + backoff, JSON-RPC batch + multicall, in-flight read dedupe
  batch: { multicall: { wait: 16 } },
  transports: { [robinhoodChain.id]: fallbackRpc() },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
