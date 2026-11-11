/** Safe tip-destination resolution: never throw if payout is missing. */
export type TipPayoutInfo = {
  payout?: {
    address?: string | null
    name?: string | null
    resolves?: string | null
  } | null
  wallets?: { address: string }[] | null
}

/** Prefer the saved payout address; fall back to the first linked wallet. */
export function tipPayoutTarget(d?: TipPayoutInfo | null): string | null {
  const fromPayout = d?.payout?.address?.trim() || null
  const fromWallet = d?.wallets?.[0]?.address?.trim() || null
  return fromPayout ?? fromWallet
}

/** True when a linked .wif now resolves to a different wallet than the saved payout. */
export function tipPayoutMismatch(d?: TipPayoutInfo | null, cur?: string | null): boolean {
  const name = d?.payout?.name
  const resolves = d?.payout?.resolves
  return !!(name && resolves && cur && resolves.toLowerCase() !== cur)
}
