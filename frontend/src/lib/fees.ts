import { CLAIM_SPLIT, FEE_BPS, FEE_SPLIT, TOPSPOT_FEE_SHARE, TOPSPOT_HOLDER_SHARE, TOPSPOT_MIN_RAISE } from '../config'

export type FeeParts = { treasury: number; pot: number; burn: number }
export type FeeSplit = { amount: number; fee: number; receives: number } & FeeParts
/** Which split a fee follows: 'fee' (every fee, FEE_SPLIT) or 'claim' (.wif name claims, CLAIM_SPLIT). */
export type SplitKind = 'fee' | 'claim'

/** The split as whole percents, with zero shares filled in. */
export const shares = (kind: SplitKind = 'fee'): FeeParts => {
  const s: Partial<FeeParts> = kind === 'claim' ? CLAIM_SPLIT : FEE_SPLIT
  return { treasury: s.treasury ?? 0, pot: s.pot ?? 0, burn: s.burn ?? 0 }
}

/** How a fee splits: 90% weekly community pot, 10% burned (claims: 50% treasury, 50% pot). */
export function splitFee(fee: number, kind: SplitKind = 'fee'): FeeParts {
  const f = Math.max(0, fee || 0), s = shares(kind)
  return { treasury: (f * s.treasury) / 100, pot: (f * s.pot) / 100, burn: (f * s.burn) / 100 }
}

const PART_NAME: Record<keyof FeeParts, string> = { treasury: 'treasury', pot: 'weekly community pot', burn: 'burned' }
/** e.g. "90% weekly community pot · 10% burned". Zero shares are left out. */
export const splitLabel = (kind: SplitKind = 'fee', sep = ' · ') =>
  (['treasury', 'pot', 'burn'] as const).filter(k => shares(kind)[k] > 0).map(k => `${shares(kind)[k]}% ${PART_NAME[k]}`).join(sep)
export const FEE_SPLIT_LABEL = splitLabel('fee')
export const CLAIM_SPLIT_LABEL = splitLabel('claim')

/** Fee is taken out of the amount: the recipient receives amount minus the fee. */
export function feeSplit(amount: number): FeeSplit {
  const a = Math.max(0, amount || 0)
  const fee = (a * FEE_BPS) / 10_000
  return { amount: a, fee, receives: a - fee, ...splitFee(fee) }
}

/** A promotion bid: the outbid holder gets 90% back, the rest is the fee. On an empty spot the whole bid is the fee. */
export function topSpotSplit(bid: number, empty = false) {
  const toHolder = empty ? 0 : bid * TOPSPOT_HOLDER_SHARE
  const fee = empty ? bid : bid * TOPSPOT_FEE_SHARE
  return { bid, toHolder, fee, ...splitFee(fee) }
}

export function topSpotMinBid(current: number) {
  return Math.ceil(current * (1 + TOPSPOT_MIN_RAISE))
}

export const FEE_PERCENT_LABEL = `${FEE_BPS / 100}%`
