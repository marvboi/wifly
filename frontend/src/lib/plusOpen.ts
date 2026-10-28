/** Plus is buyable only once the team wallet's onchain price is set (> 0). Off-chain preview stays open; unread prices are not open yet. */
export function plusOpen(live: boolean, loaded: boolean, month?: bigint, year?: bigint) {
  if (!live) return { monthOpen: true, yearOpen: true }
  return { monthOpen: loaded && !!month && month > 0n, yearOpen: loaded && !!year && year > 0n }
}
