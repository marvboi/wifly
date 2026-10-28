export function wif(n: number, opts: { decimals?: number; unit?: boolean } = {}) {
  const { decimals, unit = true } = opts
  const d = decimals ?? (Math.abs(n) >= 100 || Number.isInteger(n) ? 0 : 2)
  const s = n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
  return unit ? `${s} WIF` : s
}

export function compact(n: number) {
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

export function shortAddr(a?: string) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''
}

/** A username as people see it: always the plain @name, never @name.wif. */
export const at = (handle?: string | null) => !handle ? '' : `@${handle.replace(/\.wif$/i, '')}`
