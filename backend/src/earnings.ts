/**
 * Creator earnings mirror: onchain withdrawable balance plus fee-split labels for the Flat UI.
 */
import type { Hono } from 'hono'
import { parseAbi, type Address } from 'viem'
import { walletsOfUser } from './accounts'
import { needUser, type Env } from './auth'
import { chainClient } from './chain'
import { FLAT_FEE_SPLIT, FEE_SPLIT, paymentsContract, wiflyContract } from './config'

const BAL_ABI = parseAbi(['function balances(address) view returns (uint256)'])

export type EarningsView = {
  live: boolean
  withdrawableWif: number
  split: typeof FLAT_FEE_SPLIT
  legacySplit: typeof FEE_SPLIT
  paymentsLive: boolean
  sources: { label: string; note: string }[]
  payouts: { label: string; note: string }[]
}

export async function earningsFor(uid: number): Promise<EarningsView> {
  const W = wiflyContract()
  const wallets = await walletsOfUser(uid)
  let raw = 0n
  if (W) {
    await Promise.all(wallets.map(async w => {
      try {
        raw += await chainClient().readContract({ address: W, abi: BAL_ABI, functionName: 'balances', args: [w as Address] })
      } catch { /* partial read */ }
    }))
  }
  return {
    live: !!W,
    withdrawableWif: Number(raw) / 1e18,
    split: FLAT_FEE_SPLIT,
    legacySplit: FEE_SPLIT,
    paymentsLive: !!paymentsContract(),
    sources: [
      { label: 'tips', note: 'net of the platform fee; the fee slice follows the active split' },
      { label: 'subscriptions', note: 'creator tiers and unlocks credit here' },
      { label: 'top spot', note: '90% of an outbid returns here when you were holder' },
      { label: 'treasury share', note: '20% of each platform fee once Flat split is live' },
    ],
    payouts: [{ label: 'withdraw', note: 'pull the full withdrawable balance from Wifly any time' }],
  }
}

export function mountEarnings(app: Hono<Env>) {
  app.get('/api/earnings', async c => {
    const uid = needUser(c)
    return c.json(await earningsFor(uid))
  })
}