/** 11.8.8: decode the onchain agent for one wallet. pure (no wagmi), so node tests can use it.
 *  Wifly.agents(user) = (agent, dailyCap, spentToday, day); agentRemaining(user) = what's left today.
 *  The chain is the source of truth for on/off, cap, spent today and what's left; spentToday only counts when day is today. */
import { formatUnits } from 'viem'

type Addr = `0x${string}`
export type AgentTuple = readonly [Addr, bigint, bigint, bigint]
export type AgentChain = { agent: Addr | undefined; enabled: boolean; dailyCap: number; spentToday: number; day: number; remaining: number }

/** The contract's day number: block.timestamp / 1 days. */
export const chainDay = (ms = Date.now()) => Math.floor(ms / 86_400_000)
const wif = (v: bigint) => Number(formatUnits(v, 18))

export function decodeAgent(a: AgentTuple | undefined, rem: bigint | undefined, today = chainDay()): AgentChain {
  const agent = a?.[0]
  const enabled = !!agent && !/^0x0{40}$/i.test(agent)
  const dailyCap = a && enabled ? wif(a[1]) : 0
  const day = a ? Number(a[3]) : 0
  const spentToday = a && enabled && day === today ? Math.min(wif(a[2]), dailyCap) : 0
  const remaining = !enabled ? 0 : rem !== undefined ? wif(rem) : Math.max(0, dailyCap - spentToday)
  return { agent: enabled ? agent : undefined, enabled, dailyCap, spentToday, day, remaining }
}
