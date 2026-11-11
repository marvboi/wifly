import { plusOpen } from './plusOpen'
import { sendRoute, shortA } from './payer'
import { openWalletMenu, usePayerState } from './payerStore'
import { CANCELLED_LINE, GAS_LINE, PENDING_LINE, classifyTxError, shortOnGas, userError } from './txError'
export { userError }
import { useAnyAccount } from '../auth/privyBridge'
import { privyBridge, usePrivyState } from '../auth/privyBridge'
/**
 * Wifly contract wiring (contracts/src/Wifly.sol).
 *
 * Reads: real contract views when VITE_WIFLY_ADDRESS is set; otherwise hooks return undefined and screens show empty states.
 * Writes: every action is built as a Plan (an optional WIF approve, then one Wifly call) and goes
 * through sendPlan(). sendPlan() refuses to send while TX_ENABLED is false, so this build never sends a transaction.
 */
import { useCallback } from 'react'
import { LINK_REQUIRED_EVENT } from '../api/client'
import {
  BaseError, ContractFunctionRevertedError, decodeErrorResult, UserRejectedRequestError, encodeFunctionData, erc20Abi, formatUnits,
  keccak256, parseUnits, toBytes, zeroAddress, type Address, type Hex,
} from 'viem'
import { useAccount, usePublicClient, useReadContract, useReadContracts, useSendTransaction } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { BADGES_ADDRESS, LIVE, NAMES_ADDRESS, PLUS_PRICE_FALLBACK, PLUS_PRICE_YEAR_FALLBACK, PLUS_TIER, robinhoodChain, TX_ENABLED, WIF_DECIMALS, WIF_TOKEN, WIFLY_ADDRESS, WIFLY_TEAM_WALLET } from '../config'
import { namesAbi } from '../contracts/namesAbi'
import { badgesAbi } from '../contracts/badgesAbi'
import { wiflyAbi } from '../contracts/wiflyAbi'
import { feeSplit, splitFee, type FeeParts, type FeeSplit, type SplitKind } from './fees'

const chainId = robinhoodChain.id
const W = WIFLY_ADDRESS ?? zeroAddress
const base = { address: W, abi: wiflyAbi, chainId } as const
const on = (extra = true) => ({ query: { enabled: LIVE && extra } })

export const toWei = (n: number) => parseUnits(String(Math.max(0, n || 0)), WIF_DECIMALS)
export const fromWei = (v: bigint) => Number(formatUnits(v, WIF_DECIMALS))

/** Stable bytes32 ids for app objects. Posts, locked content and orders are namespaced so they never collide. */
export const id32 = (kind: 'post' | 'content' | 'order' | 'dm' | 'paylink', id: string): Hex => keccak256(toBytes(`${kind}:${id}`))

/**
 * X tips: handleHash = keccak256("x:" + numericXUserId), matching Wifly.sol and its README.
 * Always the numeric X user id (it never changes), never the @handle (it can be renamed).
 */
export const xHandleHash = (numericXUserId: string): Hex => keccak256(toBytes(`x:${numericXUserId.trim()}`))

/**
 * @handle -> numeric X user id. The backend knows it for anyone who signed in to wifly with X: the id comes from
 * Privy's verified identity token, never from what the browser says. Anyone else: null, and the tip sheet asks
 * for the numeric id.
 */
export async function resolveXUserId(handle: string): Promise<string | null> {
  const h = handle.trim().replace(/^@/, '')
  if (!h) return null
  try {
    const r = await fetch(`/api/x/resolve?handle=${encodeURIComponent(h)}`, { credentials: 'same-origin' })
    return r.ok ? ((await r.json()) as { xUserId: string | null }).xUserId : null
  } catch { return null }
}

export type LinkAttestation = { xUserId: string; handleHash: Hex; account: Address; nonce: string; deadline: string; signature: Hex }
/**
 * Claiming X tips: the backend reads your numeric X id from Privy's verified identity token and signs the EIP-712
 * LinkHandle(handleHash, account, nonce = handleNonce(handleHash), deadline) message for one of your own wallets
 * (domain { name: "Wifly", version: "1", chainId: 4663, verifyingContract: WIFLY_ADDRESS }).
 * Your wallet then calls linkHandle(handleHash, deadline, signature) to pull the escrowed tips (sent via
 * sendPlan, so nothing goes out while TX_ENABLED is false).
 */
export async function fetchLinkAttestation(identityToken: string, account?: Address): Promise<LinkAttestation> {
  const r = await fetch('/api/x/attest', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-wifly': '1' },
    body: JSON.stringify({ identityToken, account }),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? 'could not get the X link signature')
  return body as LinkAttestation
}

/** Sample tiers t1/t2/t3 map to on-chain tier indexes 0/1/2. */
export const tierIndex = (tierId: string) => Math.max(0, Math.min(2, Number(tierId.replace(/\D/g, '')) - 1 || 0))

// ------------------------------------------------------------------ views

/** quoteFee(amount) from the contract, or the same math locally when the contract isn't set. */
export function useQuoteFee(amount: number): FeeSplit & { source: 'contract' | 'sample' } {
  const q = useReadContract({ ...base, functionName: 'quoteFee', args: [toWei(amount)], ...on(amount > 0) })
  if (LIVE && q.data) {
    // Wifly.quoteFee: (fee, potPart, burnPart, net). No treasury share on fees.
    const [fee, pot, burn, net] = q.data
    return { amount, fee: fromWei(fee), treasury: 0, pot: fromWei(pot), burn: fromWei(burn), receives: fromWei(net), source: 'contract' }
  }
  return { ...feeSplit(amount), source: 'sample' }
}

/** Fee split from the contracts: Wifly.quoteSplit -> (pot, burn); claims: WiflyNames.quoteClaimSplit -> (treasury, pot).
 *  Local FEE_SPLIT / CLAIM_SPLIT math when not live. */
export function useQuoteSplit(fee: number, kind: SplitKind = 'fee'): FeeParts & { source: 'contract' | 'sample' } {
  const f = useReadContract({ ...base, functionName: 'quoteSplit', args: [toWei(fee)], ...on(fee > 0 && kind === 'fee') })
  const c = useReadContract({ address: NAMES_ADDRESS ?? zeroAddress, abi: namesAbi, chainId, functionName: 'quoteClaimSplit', args: [toWei(fee)],
    query: { enabled: LIVE && !!NAMES_ADDRESS && fee > 0 && kind === 'claim' } })
  if (LIVE && kind === 'fee' && f.data) {
    const [pot, burn] = f.data
    return { treasury: 0, pot: fromWei(pot), burn: fromWei(burn), source: 'contract' }
  }
  if (LIVE && kind === 'claim' && c.data) {
    const [treasury, pot] = c.data
    return { treasury: fromWei(treasury), pot: fromWei(pot), burn: 0, source: 'contract' }
  }
  return { ...splitFee(fee, kind), source: 'sample' }
}

/** Single-value views: undefined while loading or when not live. */
export function useTotalBurned() {
  const q = useReadContract({ ...base, functionName: 'totalBurned', ...on(), query: { enabled: LIVE, refetchInterval: 20_000 } })
  return q.data !== undefined ? fromWei(q.data) : undefined
}
export function useCommunityPot() {
  const q = useReadContract({ ...base, functionName: 'communityPot', ...on(), query: { enabled: LIVE, refetchInterval: 20_000 } })
  return q.data !== undefined ? fromWei(q.data) : undefined
}
export function useInAppBalance(user?: Address) {
  const q = useReadContract({ ...base, functionName: 'balances', args: [user ?? zeroAddress], ...on(!!user) })
  return q.data !== undefined ? fromWei(q.data) : undefined
}

/** Weekly crowd pick: current epoch, when it ends, leader, the epoch pot and the winner/voter split. */
export function useEpochState() {
  const ep = useReadContract({ ...base, functionName: 'currentEpoch', ...on() })
  const epoch = ep.data
  const r = useReadContracts({
    contracts: [
      { ...base, functionName: 'epochs', args: [epoch ?? 0n] },
      { ...base, functionName: 'epochEndsAt', args: [epoch ?? 0n] },
      { ...base, functionName: 'epochPot' },
      { ...base, functionName: 'winnerShareBps' },
      { ...base, functionName: 'voterShareBps' },
    ],
    query: { enabled: LIVE && epoch !== undefined, refetchInterval: 30_000 },
  })
  if (!LIVE || epoch === undefined || !r.data) return undefined
  const [e, ends, pot, wBps, vBps] = r.data.map(x => x.result)
  const ee = e as readonly [Address, boolean, bigint, bigint, bigint] | undefined
  return {
    epoch,
    endsAt: ends !== undefined ? Number(ends as bigint) : undefined,
    leader: ee?.[0], finalized: ee?.[1], leaderVotes: ee ? fromWei(ee[2]) : undefined,
    pot: pot !== undefined ? fromWei(pot as bigint) : undefined,
    winnerShare: wBps !== undefined ? Number(wBps as bigint) / 10_000 : undefined,
    voterShare: vBps !== undefined ? Number(vBps as bigint) / 10_000 : undefined,
  }
}

export function useCreatorVotes(epoch?: bigint, creator?: Address, voter?: Address) {
  const r = useReadContracts({
    contracts: [
      { ...base, functionName: 'creatorVotes', args: [epoch ?? 0n, creator ?? zeroAddress] },
      { ...base, functionName: 'voterVotes', args: [epoch ?? 0n, voter ?? zeroAddress, creator ?? zeroAddress] },
    ],
    query: { enabled: LIVE && epoch !== undefined && !!creator },
  })
  const [c, v] = r.data?.map(x => x.result as bigint | undefined) ?? []
  return { creatorVotes: c !== undefined ? fromWei(c) : undefined, yourVotes: v !== undefined ? fromWei(v) : undefined }
}

/** Claimable voter rewards for the last `lookback` closed weeks (pendingVoterReward per epoch, > 0 only). */
export function useClaimableRewards(current?: bigint, voter?: Address, lookback = 8) {
  const eps: bigint[] = []
  if (current !== undefined) for (let i = 1n; i <= BigInt(lookback) && current - i >= 0n; i++) eps.push(current - i)
  const r = useReadContracts({
    contracts: eps.map(e => ({ ...base, functionName: 'pendingVoterReward' as const, args: [e, voter ?? zeroAddress] as const })),
    query: { enabled: LIVE && !!voter && eps.length > 0, refetchInterval: 60_000 },
  })
  const items = r.data ? eps.map((e, i) => ({ epoch: e, amount: r.data![i]?.result !== undefined ? fromWei(r.data![i].result as bigint) : 0 })).filter(x => x.amount > 0) : []
  return { items, loading: r.isLoading, refetch: r.refetch }
}

export function usePendingVoterReward(epoch?: bigint, voter?: Address) {
  const q = useReadContract({ ...base, functionName: 'pendingVoterReward', args: [epoch ?? 0n, voter ?? zeroAddress], ...on(epoch !== undefined && !!voter) })
  return q.data !== undefined ? fromWei(q.data) : undefined
}

export function useIsSubscribed(user?: Address, creator?: Address) {
  const q = useReadContract({ ...base, functionName: 'isSubscribed', args: [user ?? zeroAddress, creator ?? zeroAddress], ...on(!!user && !!creator) })
  if (!q.data) return undefined
  const [active, tier, expiry] = q.data
  return { active, tier: Number(tier), expiry: Number(expiry) }
}

/**
 * Wifly Plus = a subscription to the Wifly team wallet's Plus tier.
 * Live (contract + team wallet set): active comes from isSubscribed(user, teamWallet) and price from tierPrices(teamWallet).
 * Otherwise it falls back to the local preview toggle.
 */
export function usePlusStatus(localPlus: boolean) {
  const { address } = useAnyAccount()
  const live = LIVE && !!WIFLY_TEAM_WALLET
  const team = WIFLY_TEAM_WALLET ?? zeroAddress
  const r = useReadContracts({
    contracts: [
      { ...base, functionName: 'subStatus', args: [address ?? zeroAddress, team] },
      { ...base, functionName: 'autoRenewOf', args: [address ?? zeroAddress, team] },
    ],
    query: { enabled: live && !!address, refetchInterval: 30_000 },
  })
  // prices don't depend on who's looking: read them without a wallet so a 0 (not set yet) shows as "opens soon", never a fallback
  const pr = useReadContracts({
    contracts: [
      { ...base, functionName: 'tierPrices', args: [team] },
      { ...base, functionName: 'yearlyPrices', args: [team] },
    ],
    query: { enabled: live, refetchInterval: 60_000 },
  })
  const [st, ar] = r.data?.map(x => x.result) ?? []
  const [mp, yp] = pr.data?.map(x => x.result) ?? []
  const s = st as readonly [boolean, boolean, number, bigint, bigint, number] | undefined
  const a = ar as readonly [number, number, bigint] | undefined
  const m = (mp as readonly bigint[] | undefined)?.[PLUS_TIER]
  const y = (yp as readonly bigint[] | undefined)?.[PLUS_TIER]
  const price = m && m > 0n ? fromWei(m) : PLUS_PRICE_FALLBACK
  const yearPrice = y && y > 0n ? fromWei(y) : PLUS_PRICE_YEAR_FALLBACK
  const { monthOpen, yearOpen } = plusOpen(live, !!pr.data, m, y)
  const plan: PlusPlanId = s?.[5] === 1 ? 'year' : 'month'
  const maxPrice = a ? fromWei(a[2]) : 0
  const current = (a?.[1] === 1 ? 'year' : 'month') === 'year' ? yearPrice : price
  return {
    live, team: WIFLY_TEAM_WALLET, price, yearPrice, plan, monthOpen, yearOpen, pricesLoading: live && !pr.data,
    active: live ? !!s?.[0] : localPlus, hasAccess: live ? !!s?.[1] : localPlus,
    expiry: s ? Number(s[3]) : undefined, graceEndsAt: s ? Number(s[4]) : undefined,
    autoRenew: maxPrice > 0, maxPrice, priceChanged: maxPrice > 0 && current > maxPrice,
  }
}

export function useHasUnlocked(user?: Address, creator?: Address, contentId?: Hex) {
  const q = useReadContract({ ...base, functionName: 'hasUnlocked', args: [user ?? zeroAddress, creator ?? zeroAddress, contentId ?? '0x'.padEnd(66, '0') as Hex], ...on(!!user && !!creator && !!contentId) })
  return q.data
}

/** Top Spot rules from the contract: minimum bid, when the current holder's minimum hold ends, and who holds it. */
export function useTopSpotRules() {
  const r = useReadContracts({
    contracts: [
      { ...base, functionName: 'minTopSpotBid' },
      { ...base, functionName: 'topSpotUnlocksAt' },
      { ...base, functionName: 'topSpot' },
    ],
    query: { enabled: LIVE, refetchInterval: 10_000 },
  })
  if (!LIVE || !r.data) return undefined
  const [min, unlocks, spot] = r.data.map(x => x.result)
  const s = spot as readonly [Address, bigint, Hex, bigint] | undefined
  return {
    minBid: min !== undefined ? fromWei(min as bigint) : undefined,
    unlocksAt: unlocks !== undefined ? Number(unlocks as bigint) : 0,
    holder: s?.[0], empty: !s || s[0] === zeroAddress, amount: s ? fromWei(s[3]) : undefined,
  }
}

import { decodeAgent, type AgentTuple } from './agentChain'
export { chainDay, decodeAgent, type AgentChain } from './agentChain'

/** Reads the agent for `user` (the CURRENT payer wallet). The query key carries the address, so switching payer re-reads;
 *  every confirmed tx invalidates all queries (useSendPlan), and refetch() is there for an explicit re-read. */
export function useAgentOnChain(user?: Address | string | null) {
  const u = (user && /^0x[0-9a-fA-F]{40}$/.test(user) ? user : undefined) as Address | undefined
  const r = useReadContracts({
    contracts: [
      { ...base, functionName: 'agents', args: [u ?? zeroAddress] },
      { ...base, functionName: 'agentRemaining', args: [u ?? zeroAddress] },
    ],
    query: { enabled: LIVE && !!u, refetchOnWindowFocus: true },
  })
  const ok = !!r.data && r.data.every(x => x.status === 'success')
  const data = ok ? decodeAgent(r.data![0].result as AgentTuple, r.data![1].result as bigint) : undefined
  return { data, loading: LIVE && !!u && !ok && !r.isError, error: r.isError || (!!r.data && !ok), refetch: r.refetch, address: u }
}

export function useWiflyAllowance(owner?: Address) {
  const q = useReadContract({ address: WIF_TOKEN, abi: erc20Abi, functionName: 'allowance', args: [owner ?? zeroAddress, W], chainId, query: { enabled: LIVE && !!owner } })
  return q.data
}

// ------------------------------------------------------------------ write plans

export type Plan = {
  label: string
  /** WIF the contract pulls with transferFrom. 0 means no approve step (from deposited balance, setAgent, withdraw…). */
  pull: bigint
  data: Hex
  /** Contract to call (and the approve spender). Defaults to Wifly. */
  to?: Address
  /** Approve this much instead of `pull` (e.g. an auto-renew cap). Never unlimited. */
  approve?: bigint
  /** ETH sent with the call (payable functions, e.g. a DCA deposit). */
  value?: bigint
}

export type PlusPlanId = 'month' | 'year'
const planIdx = (p: PlusPlanId) => (p === 'year' ? 1 : 0)
const N = NAMES_ADDRESS ?? zeroAddress
const B = BADGES_ADDRESS ?? zeroAddress
export const nameTokenId = (name: string) => BigInt(keccak256(toBytes(name.toLowerCase())))

const enc = encodeFunctionData
const zeroHash = ('0x' + '0'.repeat(64)) as Hex
export const plans = {
  tip: (creator: Address, amount: number, postId = ''): Plan =>
    ({ label: 'tip', pull: toWei(amount), data: enc({ abi: wiflyAbi, functionName: 'tip', args: [creator, toWei(amount), postId ? id32('post', postId) : zeroHash] }) }),
  tipHandle: (handleHash: Hex, amount: number, postId = ''): Plan =>
    ({ label: 'tip X account', pull: toWei(amount), data: enc({ abi: wiflyAbi, functionName: 'tipHandle', args: [handleHash, toWei(amount), postId ? id32('post', postId) : zeroHash] }) }),
  /** Claim X tips with the backend's attestation (fetchLinkAttestation). No WIF is pulled. */
  linkHandle: (a: LinkAttestation): Plan =>
    ({ label: 'link X account', pull: 0n, data: enc({ abi: wiflyAbi, functionName: 'linkHandle', args: [a.handleHash, BigInt(a.deadline), a.signature] }) }),
  subscribe: (creator: Address, tierId: string, price: number, plan: PlusPlanId = 'month'): Plan =>
    ({ label: 'subscribe', pull: toWei(price), data: enc({ abi: wiflyAbi, functionName: 'subscribePlan', args: [creator, tierIndex(tierId), planIdx(plan)] }) }),
  /** Wifly Plus = subscribePlan(PLUS creator, tier 0, plan). Also "renew now": it extends from the current expiry. */
  plus: (team: Address, price: number, plan: PlusPlanId = 'month'): Plan =>
    ({ label: 'get plus', pull: toWei(price), data: enc({ abi: wiflyAbi, functionName: 'subscribePlan', args: [team, PLUS_TIER, planIdx(plan)] }) }),
  /** Opt-in auto-renew with a price cap. The approve is capped at maxPrice (one renewal), never unlimited. maxPrice 0 = off. */
  plusAutoRenew: (team: Address, plan: PlusPlanId, maxPrice: number): Plan =>
    ({ label: maxPrice > 0 ? 'turn on auto-renew' : 'turn off auto-renew', pull: 0n, approve: maxPrice > 0 ? toWei(maxPrice) : undefined,
      data: enc({ abi: wiflyAbi, functionName: 'setAutoRenew', args: [team, PLUS_TIER, planIdx(plan), toWei(maxPrice)] }) }),
  /** Paid drop: the creator sets the unlock price for the drop's content id. */
  setContentPrice: (postId: string, price: number): Plan =>
    ({ label: 'set unlock price', pull: 0n, data: enc({ abi: wiflyAbi, functionName: 'setContentPrice', args: [id32('content', postId), toWei(price)] }) }),
  /** Creator tiers: monthly (setTier) and yearly (setYearlyPrice) prices for tier 0..2. */
  setTier: (tier: number, price: number): Plan =>
    ({ label: 'set tier price', pull: 0n, data: enc({ abi: wiflyAbi, functionName: 'setTier', args: [tier, toWei(price)] }) }),
  setYearlyPrice: (tier: number, price: number): Plan =>
    ({ label: 'set yearly price', pull: 0n, data: enc({ abi: wiflyAbi, functionName: 'setYearlyPrice', args: [tier, toWei(price)] }) }),
  // ---- WiflyNames: claim (CLAIM_SPLIT: 50% treasury / 50% pot), list / cancel, buy with a max price (2.5% fee, FEE_SPLIT)
  nameClaim: (name: string, fee: number): Plan =>
    ({ label: 'claim name', to: N, pull: toWei(fee), data: enc({ abi: namesAbi, functionName: 'claim', args: [name.toLowerCase()] }) }),
  nameList: (name: string, price: number): Plan =>
    ({ label: 'list name', to: N, pull: 0n, data: enc({ abi: namesAbi, functionName: 'list', args: [nameTokenId(name), toWei(price)] }) }),
  nameCancel: (name: string): Plan =>
    ({ label: 'delist name', to: N, pull: 0n, data: enc({ abi: namesAbi, functionName: 'cancel', args: [nameTokenId(name)] }) }),
  nameBuy: (name: string, price: number): Plan =>
    ({ label: 'buy name', to: N, pull: toWei(price), data: enc({ abi: namesAbi, functionName: 'buy', args: [nameTokenId(name), toWei(price)] }) }),
  // ---- WiflyBadges: burn WIF, soulbound badges at 1k / 10k / 100k / 1M burned
  burn: (amount: number): Plan =>
    ({ label: 'burn', to: B, pull: toWei(amount), data: enc({ abi: badgesAbi, functionName: 'burn', args: [toWei(amount)] }) }),
  unlock: (creator: Address, postId: string, price: number): Plan =>
    ({ label: 'unlock', pull: toWei(price), data: enc({ abi: wiflyAbi, functionName: 'unlock', args: [creator, id32('content', postId)] }) }),
  /** Shop items, paid DMs and pay links all use pay(seller, amount, orderId). */
  pay: (seller: Address, amount: number, kind: 'order' | 'dm' | 'paylink', ref: string): Plan =>
    ({ label: 'pay', pull: toWei(amount), data: enc({ abi: wiflyAbi, functionName: 'pay', args: [seller, toWei(amount), id32(kind, ref)] }) }),
  takeTopSpot: (postId: string, amount: number): Plan =>
    ({ label: 'take the top spot', pull: toWei(amount), data: enc({ abi: wiflyAbi, functionName: 'takeTopSpot', args: [id32('post', postId), toWei(amount)] }) }),
  vote: (creator: Address, amount: number, postId = ''): Plan =>
    ({ label: 'vote', pull: toWei(amount), data: enc({ abi: wiflyAbi, functionName: 'vote', args: [postId ? id32('post', postId) : zeroHash, creator, toWei(amount)] }) }),
  deposit: (amount: number): Plan =>
    ({ label: 'deposit', pull: toWei(amount), data: enc({ abi: wiflyAbi, functionName: 'deposit', args: [toWei(amount)] }) }),
  withdraw: (): Plan => ({ label: 'withdraw', pull: 0n, data: enc({ abi: wiflyAbi, functionName: 'withdraw' }) }),
  /** Voter share of a closed week, credited to the Wifly balance (no WIF pulled). */
  claimVoterReward: (epoch: bigint): Plan => ({ label: 'claim weekly reward', pull: 0n, data: enc({ abi: wiflyAbi, functionName: 'claimVoterReward', args: [epoch] }) }),
  setAgent: (agent: Address, dailyCap: number): Plan =>
    ({ label: 'set agent', pull: 0n, data: enc({ abi: wiflyAbi, functionName: 'setAgent', args: [agent, toWei(dailyCap)] }) }),
  revokeAgent: (): Plan => ({ label: 'turn off agent', pull: 0n, data: enc({ abi: wiflyAbi, functionName: 'revokeAgent' }) }),
}

export const approveData = (amount: bigint, spender: Address = W) => enc({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] })

/** Plain-words messages for the contract's custom errors. */
const errorText: Record<string, string> = {
  SelfPayment: 'you can’t tip, vote for or pay yourself',
  InsufficientBalance: 'not enough wif in your wifly balance',
  BidTooLow: 'someone raised the top spot. bid at least the new minimum',
  TopSpotLocked: 'the top spot is in its minimum hold. try again in a moment',
  AlreadyUnlocked: 'you already unlocked this',
  NotForSale: 'this drop isn’t for sale yet',
  TierDisabled: 'this tier isn’t switched on yet',
  ZeroAmount: 'enter an amount',
  AgentCapExceeded: 'that would pass today’s agent cap',
  EnforcedPause: 'payments are paused right now. withdrawals still work',
  BadTheme: 'pick white or green',
  NotNameOwner: 'only the holder can change this name',
}
export function explainError(e: unknown): string {
  // our own contract errors keep their calm text; everything else goes through userError (speed.12.4)
  let known: string | null = null
  if (e instanceof BaseError) {
    const rev = e.walk(x => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
    const name = rev?.data?.errorName
    if (name) known = errorText[name] ?? null
    else {
      const raw = (e.walk() as { data?: Hex })?.data
      if (raw) { try { const d = decodeErrorResult({ abi: wiflyAbi, data: raw }); known = errorText[d.errorName] ?? null } catch { /* not ours */ } }
    }
  }
  return userError(e, known)
}

/** Why a plan didn't go through: nothing sent (preview, no wallet, dry-run failed), the wallet said no, or it reverted on chain. */
export type SendFail = { sent: false; kind: 'off' | 'rejected' | 'reverted' | 'error' | 'gas' | 'pending'; reason: string; /** the wallet that needs eth (kind 'gas') */ address?: Address }
export type SendResult = SendFail | { sent: true; hash: Hex }

/** True when the error chain contains a wallet rejection (EIP-1193 code 4001). */
function isRejection(e: unknown): boolean {
  if (e instanceof BaseError && e.walk(x => x instanceof UserRejectedRequestError || (x as { code?: number })?.code === 4001)) return true
  return classifyTxError(e) === 'rejected'
}
/** A failed send, mapped to one calm line (gas / cancelled / pending / generic). */
function failFrom(e: unknown, address?: Address): SendFail {
  if (isRejection(e)) return { sent: false, kind: 'rejected', reason: CANCELLED_LINE }
  const k = classifyTxError(e)
  if (k === 'gas') return { sent: false, kind: 'gas', reason: GAS_LINE, address }
  if (k === 'pending') return { sent: false, kind: 'pending', reason: PENDING_LINE }
  return { sent: false, kind: 'error', reason: explainError(e) }
}

/**
 * Run a plan: approve if the allowance is short, then the Wifly call.
 * With the contract live it first dry-runs the call with eth_call (no signature, nothing sent) so reverts show up early.
 * Every transaction it sends is awaited with waitForTransactionReceipt, and it only reports { sent: true } once the
 * receipt says status 'success'. A rejected signature or a reverted receipt comes back as a failure, so callers never
 * celebrate (animate, add to counters) before the chain confirms.
 * It sends only when TX_ENABLED is true, and TX_ENABLED is false in this build.
 */
/**
 * 11.8.5: the wallet that pays and how its sends go out. The wallet picked in the wallet menu leads (wagmi when it's the
 * connected one, else privy: embedded or a privy-connected linked wallet). Without an account wallet list: wagmi first,
 * otherwise the privy active wallet. route 'none' = picked but not connected here yet.
 */
export function usePayerRoute() {
  const { address: wagmiAddress } = useAccount()
  const privy = usePrivyState()
  const payer = usePayerState()
  const picked = payer.options.find(o => o.address === payer.address) ?? null
  const route = picked ? sendRoute(picked.address, { wagmi: wagmiAddress, privyHas: a => privyBridge.has(a) }) : null
  const viaPrivy = picked ? route === 'privy' : !wagmiAddress && !!privy.activeWallet && privy.authenticated
  const address = picked ? picked.address as Address : (wagmiAddress ?? (viaPrivy ? privy.activeWallet as Address : undefined))
  return { address, picked, route, viaPrivy }
}
/** The calm reason when the picked wallet isn't connected here (and opens the wallet menu to fix it). */
export function notConnectedReason(picked: { address: string; kind: 'embedded' | 'linked' }) {
  openWalletMenu()
  return picked.kind === 'linked' ? `connect ${shortA(picked.address)} first, from the wallet menu` : 'sign in with the x or email login that made this wallet to use it'
}

export function useSendPlan() {
  const { address, picked, route, viaPrivy } = usePayerRoute()
  const client = usePublicClient({ chainId })
  const { sendTransactionAsync } = useSendTransaction()
  const qc = useQueryClient()

  return useCallback(async (plan: Plan): Promise<SendResult> => {
    const to = plan.to ?? W
    if (to === zeroAddress) return { sent: false, kind: 'off', reason: 'payments aren’t live yet, so nothing was sent' }
    // guests link an account before anything goes on chain (the link sheet opens; nothing is sent)
    if ((qc.getQueryData(['me']) as { me?: { guest?: boolean } | null } | undefined)?.me?.guest) {
      window.dispatchEvent(new Event(LINK_REQUIRED_EVENT))
      return { sent: false, kind: 'off', reason: 'link a wallet, x or email to continue' }
    }
    if (!address) return { sent: false, kind: 'off', reason: 'connect a wallet first' }
    if (picked && route === 'none') return { sent: false, kind: 'off', reason: notConnectedReason(picked) }
    if (!client) return { sent: false, kind: 'error', reason: 'can’t reach the network right now' }
    const want = plan.approve ?? plan.pull
    const have = want > 0n ? await client.readContract({ address: WIF_TOKEN, abi: erc20Abi, functionName: 'allowance', args: [address, to] }).catch(() => 0n) : 0n
    const needsApprove = want > 0n && have < want
    if (!needsApprove) {
      try { await client.call({ account: address, to, data: plan.data, value: plan.value }) } catch (e) { return failFrom(e, address) }
    }
    if (!TX_ENABLED) return { sent: false, kind: 'off', reason: 'sending isn’t switched on yet' }
    // gas pre-check (11.8.5): read the eth balance and an estimated cost first; short = say so and don't open the wallet
    {
      const first = needsApprove ? { to: WIF_TOKEN, data: approveData(want, to), value: undefined } : { to, data: plan.data, value: plan.value }
      const balance = await client.getBalance({ address }).catch(() => null)
      if (balance !== null) {
        let est: bigint | null = null
        try {
          const [g, fees] = await Promise.all([client.estimateGas({ account: address, ...first }), client.estimateFeesPerGas().catch(() => null)])
          const price = fees?.maxFeePerGas ?? fees?.gasPrice ?? await client.getGasPrice()
          est = g * price
        } catch (e) { if (classifyTxError(e) === 'gas') est = balance + 1n }
        if (shortOnGas(balance, est, first.value ?? 0n)) return { sent: false, kind: 'gas', reason: GAS_LINE, address }
      }
    }
    const confirm = async (target: Address, data: Hex, value?: bigint): Promise<SendResult> => {
      const hash = viaPrivy ? (picked ? await privyBridge.sendFrom(picked.address, target, data, chainId, value) : await privyBridge.sendTx(target, data, chainId, value)) : await sendTransactionAsync({ to: target, data, chainId, value })
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') return { sent: false, kind: 'reverted', reason: 'it reverted on chain. nothing moved except gas.' }
      return { sent: true, hash }
    }
    try {
      if (needsApprove) {
        const a = await confirm(WIF_TOKEN, approveData(want, to))
        if (!a.sent) return { ...a, reason: `the approval ${a.reason}` }
      }
      const r = await confirm(to, plan.data, plan.value)
      if (r.sent) await qc.invalidateQueries()
      return r
    } catch (e) {
      return failFrom(e, address)
    }
  }, [address, viaPrivy, picked, route, client, sendTransactionAsync, qc])
}

/** Toast title for a failed send. */
export const failTitle = (r: SendFail) => r.kind === 'rejected' ? 'cancelled' : r.kind === 'reverted' ? 'transaction failed' : r.kind === 'gas' ? 'needs a little eth' : r.kind === 'pending' ? 'one moment' : 'not sent'
/** toast(...failArgs(r)): calm title + line; a quiet info tone for cancelled; the wallet with a copy button when it needs gas. */
export const failArgs = (r: SendFail): [string, string, 'info' | 'warn', string | undefined] =>
  [failTitle(r), r.reason, r.kind === 'rejected' || r.kind === 'pending' ? 'info' : 'warn', r.kind === 'gas' ? r.address : undefined]
/** One inline line for a failed send: a quiet "cancelled", or the calm reason on its own (never "title: raw text"). */
export const failLine = (r: SendFail) => r.kind === 'rejected' ? CANCELLED_LINE : r.reason

/** Whether a plan will need the approve step for the connected wallet (always true when not live). */
export function useNeedsApprove(pull: number) {
  const { address } = useAnyAccount()
  const allowance = useWiflyAllowance(address)
  if (pull <= 0) return false
  if (!LIVE || allowance === undefined) return true
  return allowance < toWei(pull)
}
