import { USDG_DECIMALS, USDG_LOGO, USDG_TOKEN } from '../config'
import { getPayRates, type PayRates } from './price'

const ETH_LOGO = '/brand/eth-token.svg'

export type PayToken = 'wif' | 'usdg' | 'eth'

export type { PayRates }

const round = (n: number, decimals: number) => Math.round(n * 10 ** decimals) / 10 ** decimals

/** Display quotes for checkout labels (6-decimal USDG; live USD when /api/price is up). */
export function quotePayAmount(wifAmount: number, token: PayToken, rates?: PayRates): number {
  if (token === 'wif') return wifAmount
  const r = rates ?? getPayRates()
  if (token === 'usdg') return round(wifAmount * r.usdPerWif, USDG_DECIMALS)
  if (!r.wifPerEth || r.wifPerEth <= 0) return 0
  return round(wifAmount / r.wifPerEth, 6)
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