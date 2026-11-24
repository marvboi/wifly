import { PLACEHOLDER_PAY_QUOTES, USDG_DECIMALS, USDG_LOGO, USDG_TOKEN } from '../config'

const ETH_LOGO = '/brand/eth-token.svg'

export type PayToken = 'wif' | 'usdg' | 'eth'

/** Display quotes for checkout labels (6-decimal USDG; see docs/flat-prices.md). */
export function quotePayAmount(wifAmount: number, token: PayToken): number {
  if (token === 'wif') return wifAmount
  if (token === 'usdg') return Math.round(wifAmount * PLACEHOLDER_PAY_QUOTES.usdgPerWif * 10 ** USDG_DECIMALS) / 10 ** USDG_DECIMALS
  return Math.round((wifAmount / PLACEHOLDER_PAY_QUOTES.wifPerEth) * 1e6) / 1e6
}

export function payTokenLabel(token: PayToken): string {
  return token === 'usdg' ? 'USDG' : token
}

export function formatPayLine(amount: number, token: PayToken): string {
  const max = token === 'usdg' ? USDG_DECIMALS : token === 'eth' ? 6 : 0
  const n = max ? amount.toLocaleString(undefined, { maximumFractionDigits: max, minimumFractionDigits: 0 }) : amount.toLocaleString()
  return `${n} ${payTokenLabel(token)}`
}

/** Display line for checkout; USDG and eth use config quotes (prefixed ~ when not onchain). */
export function formatPayQuote(amount: number, token: PayToken): string {
  const line = formatPayLine(amount, token)
  return token === 'wif' ? line : `~${line}`
}

export type PayRails = { usdgConfigured: boolean; paymentsLive: boolean }

export function altPayEnabled(_rails?: PayRails): boolean {
  return !!USDG_TOKEN
}

export const PAY_TOKEN_META: Record<PayToken, { label: string; logo?: string }> = {
  wif: { label: 'wif' },
  usdg: { label: 'USDG', logo: USDG_LOGO },
  eth: { label: 'eth', logo: ETH_LOGO },
}