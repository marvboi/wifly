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

function formatAltUiAmount(amount: number, token: PayToken): string {
  if (token === 'usdg') {
    return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  if (token === 'eth') {
    if (amount === 0) return '0'
    if (amount >= 0.01) return amount.toLocaleString(undefined, { maximumFractionDigits: 4 })
    return Number(amount.toPrecision(4)).toString()
  }
  return amount.toLocaleString()
}

/** UI display only (onchain / quote math stays full precision via `quotePayAmount`). */
export function formatPayLine(amount: number, token: PayToken): string {
  const n = token === 'wif' ? amount.toLocaleString() : formatAltUiAmount(amount, token)
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