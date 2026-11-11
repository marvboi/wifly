/**
 * The list Privy's connect / login modal shows.
 * Detected browser extensions appear as options in this list; they must not bypass the picker.
 * Trust and other long-tail wallets are not a dedicated Privy entry — they come through the WalletConnect registry.
 */
import type { WalletListEntry } from '@privy-io/react-auth'

export const WC_PROJECT_ID = (import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID ?? '').trim()

const NAMED: WalletListEntry[] = [
  'metamask',
  'coinbase_wallet',
  'rainbow',
  'rabby_wallet',
  'okx_wallet',
  'zerion',
  'uniswap',
  'bybit_wallet',
  'bitget_wallet',
  'kraken_wallet',
  'safe',
  'detected_ethereum_wallets',
]

/** wallet_connect = the "more wallets" registry (desktop + mobile). wallet_connect_qr = QR row, desktop only (Privy hides it on mobile). */
const WC_ENTRIES: WalletListEntry[] = ['wallet_connect', 'wallet_connect_qr']

export const PRIVY_WALLET_LIST: WalletListEntry[] = [
  ...NAMED,
  ...(WC_PROJECT_ID ? WC_ENTRIES : []),
]
