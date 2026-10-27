/**
 * The Wifly companion's agent: chat commands -> a confirm card -> one onchain call through the contract's agent path.
 *
 * Agent path (contracts/src/Wifly.sol): the user authorises ONE agent address with a daily WIF cap (setAgent /
 * revokeAgent, read back with agents(user) and agentRemaining(user)). The agent may only call
 * tipFor / subscribeFor / subscribeForPlan / takeTopSpotFor, which spend from the user's DEPOSITED Wifly balance
 * (balances(user)), never from their wallet, and revert with AgentCapExceeded above the cap. The agent can never
 * withdraw: withdraw() / withdrawAmount() only pay msg.sender.
 *
 * Whitelist here mirrors that: tip, subscribe, renew Plus, promote a drop. Anything else is refused. Every command is
 * re-parsed on the server at execute time; the client's confirm card is only a preview of the same parse.
 * Sending needs: WIFLY_CONTRACT_ADDRESS + AGENT_TX_ENABLED=true + a signer (AGENT_PRIVATE_KEY, server-only) that the
 * user authorised onchain. Otherwise the action is logged as a labelled preview with no tx hash (never a fake one).
 */
import type { Hono } from 'hono'
import { keccak256, parseAbi, toBytes, encodeFunctionData, formatUnits, parseUnits, type Address, type Hex } from 'viem'
import { needUser, type Env } from '../auth'
import { chainClient } from '../chain'
import { demoSeedAllowed, plusCreator, wiflyContract } from '../config'
import { all, one, run } from '../db'
import { hydrateUsers } from '../hydrate'
import { plusView, resolveName } from '../features'
import { getPrice } from '../price'
import { fail, rateLimit } from '../util'
import { plusAccess } from '../plusGate'
import { loadAgentSigner } from './signer'

/** Exact Wifly.sol agent-path signatures (mirrored from the contract). */
export const AGENT_ABI = parseAbi([
  'function setAgent(address agent, uint128 dailyCap)',
  'function revokeAgent()',
  'function agents(address user) view returns (address agent, uint128 dailyCap, uint128 spentToday, uint64 day)',
  'function agentRemaining(address user) view returns (uint256)',
  'function balances(address user) view returns (uint256)',
  'function deposit(uint256 amount)',
  'function tipFor(address user, address creator, uint256 amount, bytes32 postId)',
  'function subscribeFor(address user, address creator, uint8 tier)',
  'function subscribeForPlan(address user, address creator, uint8 tier, uint8 plan)',
  'function takeTopSpotFor(address user, bytes32 postId, uint256 amount)',
])
export const AGENT_FUNCTIONS = ['tipFor', 'subscribeFor', 'subscribeForPlan', 'takeTopSpotFor'] as const
export const WHITELIST = ['tip', 'subscribe', 'renew_plus', 'promote'] as const
type Kind = typeof WHITELIST[number]

const DEC = 18
const toWei = (n: number) => parseUnits(String(n), DEC)
const fromWei = (v: bigint) => Number(formatUnits(v, DEC))
const now = () => Date.now()
const utcDay = (t = now()) => Math.floor(t / 86400_000) // Wifly._today() = block.timestamp / 1 days
const id32 = (kind: string, id: string) => keccak256(toBytes(`${kind}:${id}`))
const FREE_MAX_CAP = 500, PLUS_MAX_CAP = 5000
const PLUS_TIER = 0
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`

export type Parsed =
  | { kind: 'tip'; to: string; amount: number }
  | { kind: 'subscribe'; to: string; tier: number }
  | { kind: 'renew_plus'; plan: 'month' | 'year' | null }
  | { kind: 'promote'; amount: number }
  | { kind: 'refuse'; reason: string }

const HELP = 'i can tip (“tip marv.wif 50”), subscribe (“subscribe to @juno”), renew your Plus (“renew my Plus”) or promote your latest drop (“promote my latest drop for 200”). nothing else.'

/** Deterministic whitelist parser. No free-form model output ever reaches the chain. */
export function parseCommand(raw: string): Parsed {
  const t = String(raw ?? '').trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
  const num = (s: string) => Number(s.replace(/,/g, ''))
  if (!t) return { kind: 'refuse', reason: HELP }
  if (/\b(withdraw|cash ?out|transfer (all|everything)|send (all|everything)|drain|approve)\b/.test(t)) return { kind: 'refuse', reason: 'the agent can never withdraw or move your balance out. only you can, from your wallet.' }
  let m = t.match(new RegExp(`^(?:tip|send|give) (\\S+) ${NUM}(?: ?\\$?wif)?$`))
  if (m) return { kind: 'tip', to: m[1], amount: num(m[2]) }
  m = t.match(new RegExp(`^(?:tip|send|give) ${NUM}(?: ?\\$?wif)? to (\\S+)$`))
  if (m) return { kind: 'tip', to: m[2], amount: num(m[1]) }
  m = t.match(/^(?:subscribe|sub)(?: to)? (\S+)(?: (?:tier ?)?([123]))?$/)
  if (m) return m[1] === 'plus' || m[1] === 'wifly' ? { kind: 'renew_plus', plan: null } : { kind: 'subscribe', to: m[1], tier: Number(m[2] ?? 1) }
  m = t.match(/^(?:renew|extend|get)(?: my)?(?: wifly)? plus(?: (monthly|yearly|month|year))?$/)
  if (m) return { kind: 'renew_plus', plan: m[1] ? (m[1].startsWith('y') ? 'year' : 'month') : null }
  m = t.match(new RegExp(`^promote(?: my)?(?: latest)?(?: drop| post)?(?: for)? ${NUM}(?: ?\\$?wif)?$`))
  if (m) return { kind: 'promote', amount: num(m[1]) }
  return { kind: 'refuse', reason: HELP }
}

type Recipient = { input: string; kind: 'wif' | 'handle' | 'address'; label: string; address: string | null; source: 'chain' | 'mirror' | 'db' | 'raw'; user?: unknown }

export async function resolveRecipient(input: string, viewer: number | null): Promise<Recipient | null> {
  const s = input.trim().toLowerCase()
  if (/^0x[0-9a-f]{40}$/.test(s)) return { input, kind: 'address', label: `${s.slice(0, 6)}…${s.slice(-4)}`, address: s, source: 'raw' }
  if (s.endsWith('.wif')) {
    const n = s.slice(0, -4)
    const r = await resolveName(n)
    if (!r) return { input, kind: 'wif', label: `${n}.wif`, address: null, source: wiflyContract() ? 'chain' : 'mirror' }
    const row = await one<{ owner_id: number }>('SELECT owner_id FROM names WHERE name = ?', [n])
    const user = row ? (await hydrateUsers([Number(row.owner_id)], viewer)).get(Number(row.owner_id)) : undefined
    return { input, kind: 'wif', label: `${n}.wif`, address: r.address, source: r.source, user }
  }
  const h = s.replace(/^@/, '')
  if (!/^[a-z0-9_]{3,20}$/.test(h)) return null
  const u = await one<{ id: number; address: string | null; wallet: string | null }>(`SELECT id, address,
    (SELECT wallet FROM privy_accounts p WHERE p.user_id = users.id ORDER BY updated_at DESC LIMIT 1) AS wallet FROM users WHERE handle = ?`, [h])
  if (!u) return null
  const user = (await hydrateUsers([Number(u.id)], viewer)).get(Number(u.id))
  return { input, kind: 'handle', label: `@${h}`, address: (u.address ?? u.wallet)?.toLowerCase() ?? null, source: 'db', user }
}

async function walletOf(uid: number): Promise<Address | null> {
  const u = await one<{ address: string | null; wallet: string | null }>(`SELECT address,
    (SELECT wallet FROM privy_accounts p WHERE p.user_id = users.id ORDER BY updated_at DESC LIMIT 1) AS wallet FROM users WHERE id = ?`, [uid])
  const a = u?.address ?? u?.wallet
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as Address) : null
}

const sendingEnabled = () => process.env.AGENT_TX_ENABLED === 'true' && !!wiflyContract() && !!loadAgentSigner()

export type AgentState = {
  enabled: boolean; cap: number; spentToday: number; remaining: number; deposited: number; maxCap: number
  source: 'chain' | 'app'; live: boolean; sending: boolean; agentAddress: string | null; authorized: boolean
  whitelist: readonly string[]; functions: readonly string[]
}

export async function agentState(uid: number): Promise<AgentState> {
  const plus = (await plusView(uid)).check
  const maxCap = plus ? PLUS_MAX_CAP : FREE_MAX_CAP
  const signer = loadAgentSigner()
  const W = wiflyContract(), user = await walletOf(uid)
  const base = { maxCap, live: !!W, sending: sendingEnabled(), agentAddress: signer?.address ?? (process.env.AGENT_ADDRESS || null), whitelist: WHITELIST, functions: AGENT_FUNCTIONS }
  if (W && user) {
    try {
      const c = chainClient()
      const [a, rem, bal] = await Promise.all([
        c.readContract({ address: W, abi: AGENT_ABI, functionName: 'agents', args: [user] }),
        c.readContract({ address: W, abi: AGENT_ABI, functionName: 'agentRemaining', args: [user] }),
        c.readContract({ address: W, abi: AGENT_ABI, functionName: 'balances', args: [user] }),
      ])
      const [agent, dailyCap, spent, day] = a
      const cap = fromWei(dailyCap)
      const on = !/^0x0{40}$/i.test(agent)
      return { ...base, enabled: on, cap, spentToday: Number(day) === utcDay() ? fromWei(spent) : 0, remaining: fromWei(rem), deposited: fromWei(bal),
        source: 'chain', authorized: on && !!base.agentAddress && agent.toLowerCase() === base.agentAddress.toLowerCase() }
    } catch { /* rpc trouble: fall back to the app mirror below */ }
  }
  const row = await one<{ daily_cap: number; enabled: number; deposited: number }>('SELECT daily_cap, enabled, deposited FROM agent_caps WHERE user_id = ?', [uid])
  const spent = Number((await one<{ s: number | null }>(`SELECT SUM(amount) AS s FROM agent_actions WHERE user_id = ? AND day = ? AND status = 'sent'`, [uid, utcDay()]))?.s ?? 0)
  const enabled = !!Number(row?.enabled), cap = enabled ? Math.min(Number(row?.daily_cap ?? 0), maxCap) : 0
  return { ...base, enabled, cap, spentToday: spent, remaining: Math.max(0, cap - spent), deposited: Number(row?.deposited ?? 0), source: 'app', authorized: enabled }
}

export type PlannedAction = {
  ok: boolean; kind: Kind | 'refuse'; command: string; summary: string; refuse?: string
  recipient?: Recipient | null; amount?: number; usd?: number | null; plan?: 'month' | 'year'; tier?: number
  call?: { fn: typeof AGENT_FUNCTIONS[number]; args: string[] }
  needsTopUp?: { shortfall: number } | null; state: AgentState
}

export async function planCommand(uid: number, text: string): Promise<PlannedAction> {
  const p = parseCommand(text)
  const state = await agentState(uid)
  const usdOf = async (n: number) => { try { const pr = await getPrice(); return pr.usd ? Math.round(n * pr.usd * 100) / 100 : null } catch { return null } }
  const out = (o: Omit<PlannedAction, 'state' | 'command'>): PlannedAction => ({ ...o, command: text, state })
  const refuse = (reason: string, extra: Partial<PlannedAction> = {}) => out({ ok: false, kind: p.kind === 'refuse' ? 'refuse' : p.kind, summary: 'can’t do that', refuse: reason, ...extra })
  if (p.kind === 'refuse') return refuse(p.reason)
  const me = await walletOf(uid)
  let amount = 0, recipient: Recipient | null = null, call: PlannedAction['call'], summary = '', plan: 'month' | 'year' | undefined, tier: number | undefined
  const u = me ?? '(your wallet)'
  if (p.kind === 'tip') {
    amount = p.amount
    if (!(amount > 0) || amount > 1_000_000) return refuse('tips are between 0 and 1,000,000 WIF')
    recipient = await resolveRecipient(p.to, uid)
    if (!recipient) return refuse(`i couldn’t find ${p.to}. try name.wif, @handle or a 0x address.`)
    if (!recipient.address) return refuse(`${recipient.label} doesn’t point to a wallet yet, so there’s nowhere to send WIF.`, { recipient })
    if (me && recipient.address === me.toLowerCase()) return refuse('that’s your own wallet.', { recipient })
    call = { fn: 'tipFor', args: [u, recipient.address, toWei(amount).toString(), '0x0…0'] }
    summary = `tip ${recipient.label} ${amount.toLocaleString('en-US')} WIF`
  } else if (p.kind === 'subscribe') {
    recipient = await resolveRecipient(p.to, uid)
    if (!recipient) return refuse(`i couldn’t find ${p.to}.`)
    const owner = recipient.kind === 'handle' ? await one<{ id: number; extras: string }>('SELECT id, extras FROM users WHERE handle = ?', [recipient.label.slice(1)])
      : recipient.address ? await one<{ id: number; extras: string }>(`SELECT id, extras FROM users WHERE lower(address) = ? OR id IN (SELECT user_id FROM privy_accounts WHERE lower(wallet) = ?) LIMIT 1`, [recipient.address, recipient.address]) : null
    const tiers = JSON.parse(owner?.extras || '{}').tiers as { id: string; name: string; price: number }[] | undefined
    const t = tiers?.[p.tier - 1]
    if (!t) return refuse(`${recipient.label} has no tier ${p.tier} to subscribe to.`, { recipient })
    if (!recipient.address) return refuse(`${recipient.label} hasn’t linked a wallet yet.`, { recipient })
    amount = t.price; tier = p.tier
    call = { fn: 'subscribeFor', args: [u, recipient.address, String(p.tier - 1)] }
    summary = `subscribe to ${recipient.label} · ${t.name} (monthly)`
  } else if (p.kind === 'renew_plus') {
    const pv = await plusView(uid)
    plan = p.plan ?? pv.plan
    amount = pv.plans.find(x => x.id === plan)?.price ?? pv.price
    const team = plusCreator()
    recipient = { input: 'plus', kind: 'address', label: 'Wifly Plus', address: team ? team.toLowerCase() : null, source: 'raw' }
    call = { fn: 'subscribeForPlan', args: [u, team ?? '(PLUS_CREATOR_ADDRESS)', String(PLUS_TIER), plan === 'year' ? '1' : '0'] }
    summary = `renew Wifly Plus · ${plan === 'year' ? 'yearly' : 'monthly'}`
  } else if (p.kind === 'promote') {
    amount = p.amount
    const d = await one<{ id: string }>(`SELECT id FROM drops WHERE author_id = ? AND reply_to IS NULL ORDER BY created_at DESC LIMIT 1`, [uid]).catch(() => null)
    if (!d) return refuse('you don’t have a drop to promote yet.')
    call = { fn: 'takeTopSpotFor', args: [u, d.id, toWei(amount).toString()] }
    summary = `promote your latest drop for ${amount.toLocaleString('en-US')} WIF`
  }
  const usd = await usdOf(amount)
  const base = { kind: p.kind, summary, recipient, amount, usd, plan, tier, call }
  if (!state.enabled) return refuse('turn the agent on and set a daily cap first.', base)
  if (amount > state.remaining) return refuse(`that’s over your daily cap. ${state.remaining.toLocaleString('en-US')} WIF left today.`, base)
  const shortfall = Math.max(0, amount - state.deposited)
  return out({ ok: shortfall === 0, ...base, needsTopUp: shortfall > 0 ? { shortfall: Math.ceil(shortfall * 100) / 100 } : null, refuse: shortfall > 0 ? `your Wifly balance is ${state.deposited.toLocaleString('en-US')} WIF. top up ${shortfall.toLocaleString('en-US')} WIF first.` : undefined })
}

function calldata(uid: number, user: Address, a: PlannedAction): Hex {
  const r = a.recipient?.address as Address
  switch (a.kind) {
    case 'tip': return encodeFunctionData({ abi: AGENT_ABI, functionName: 'tipFor', args: [user, r, toWei(a.amount!), ('0x' + '0'.repeat(64)) as Hex] })
    case 'subscribe': return encodeFunctionData({ abi: AGENT_ABI, functionName: 'subscribeFor', args: [user, r, (a.tier ?? 1) - 1] })
    case 'renew_plus': return encodeFunctionData({ abi: AGENT_ABI, functionName: 'subscribeForPlan', args: [user, r, PLUS_TIER, a.plan === 'year' ? 1 : 0] })
    case 'promote': return encodeFunctionData({ abi: AGENT_ABI, functionName: 'takeTopSpotFor', args: [user, id32('post', a.call!.args[1]), toWei(a.amount!)] })
    default: throw new Error(`not whitelisted (${uid})`)
  }
}

/** The agent is a Wifly Plus perk: checked server-side, onchain when live (subStatus.hasAccess incl. grace). */
async function needPlus(uid: number) {
  const p = await plusAccess(uid)
  if (!p.ok) fail(403, p.state === 'unknown' ? (p.reason ?? 'couldn’t check Plus, try again') : 'the AI agent is part of Wifly Plus')
}

export function registerAgent(app: Hono<Env>) {
  app.get('/api/agent', async c => c.json(await agentState(needUser(c))))

  /** Mirror of setAgent / revokeAgent. Live: the user signs it from their wallet and we store the tx hash; the chain read wins. */
  app.put('/api/agent/cap', async c => {
    const uid = needUser(c)
    const b = await c.req.json<{ cap?: number; txHash?: string }>().catch(() => ({} as { cap?: number; txHash?: string }))
    const st = await agentState(uid)
    const cap = Number(b.cap ?? 0)
    if (!Number.isFinite(cap) || cap < 0) fail(400, 'enter a daily cap in WIF')
    if (cap > 0) await needPlus(uid) // turning the agent off always works
    if (cap > st.maxCap) fail(400, `the daily cap is up to ${st.maxCap.toLocaleString('en-US')} WIF${st.maxCap === FREE_MAX_CAP ? ' (5,000 with plus)' : ''}`)
    // Before the contract is live there is nothing to deposit into: production never books a balance that isn't onchain.
    if (!st.live && !demoSeedAllowed()) fail(503, 'agent deposits open when payments go live')
    if (st.live && !/^0x[0-9a-fA-F]{64}$/.test(b.txHash ?? '')) fail(400, 'send setAgent from your wallet first')
    await run(`INSERT INTO agent_caps (user_id, daily_cap, enabled, tx_hash, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET daily_cap = excluded.daily_cap, enabled = excluded.enabled, tx_hash = excluded.tx_hash, updated_at = excluded.updated_at`,
      [uid, cap, cap > 0 ? 1 : 0, b.txHash ?? null, now()])
    return c.json(await agentState(uid))
  })

  /** Mirror of approve(exact) + deposit(amount). Live: the user's wallet sends both and we read balances(user). */
  app.post('/api/agent/deposit', async c => {
    const uid = needUser(c)
    const b = await c.req.json<{ amount?: number; txHash?: string }>().catch(() => ({} as { amount?: number; txHash?: string }))
    const amount = Number(b.amount)
    if (!(amount > 0) || amount > 10_000_000) fail(400, 'enter an amount in WIF')
    const st = await agentState(uid)
    if (st.live && !/^0x[0-9a-fA-F]{64}$/.test(b.txHash ?? '')) fail(400, 'send the deposit from your wallet first')
    if (!st.live) await run(`INSERT INTO agent_caps (user_id, deposited, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET deposited = deposited + excluded.deposited, updated_at = excluded.updated_at`, [uid, Math.round(amount * 100) / 100, now()])
    return c.json(await agentState(uid))
  })

  app.post('/api/agent/plan', async c => {
    const uid = needUser(c)
    await rateLimit(`ap:${uid}`, 60, 60_000)
    await needPlus(uid)
    const { text } = await c.req.json<{ text?: string }>().catch(() => ({ text: '' }))
    if (String(text ?? '').length > 200) fail(400, 'keep it short')
    return c.json(await planCommand(uid, String(text ?? '')))
  })

  /** Execute a confirmed command. Re-parses server-side and checks it still matches what the user confirmed. */
  app.post('/api/agent/execute', async c => {
    const uid = needUser(c)
    await rateLimit(`ax:${uid}`, 20, 60_000)
    await needPlus(uid)
    const b = await c.req.json<{ text?: string; expect?: { kind?: string; amount?: number; to?: string | null } }>().catch(() => ({} as { text?: string; expect?: undefined }))
    const text = String(b.text ?? '').slice(0, 200)
    const a = await planCommand(uid, text)
    const day = utcDay()
    const log = async (status: 'sent' | 'preview' | 'refused' | 'failed', reason: string | null, hash: string | null) => {
      const r = await run(`INSERT INTO agent_actions (user_id, kind, command, recipient, recipient_address, amount, status, reason, tx_hash, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uid, a.kind, text, a.recipient?.label ?? null, a.recipient?.address ?? null, status === 'refused' || status === 'failed' ? 0 : a.amount ?? 0, status, reason, hash, day, now()])
      // Nothing moved when payments are off, so a 'preview' row never counts toward the daily cap or the deposit.
      return Number(r.lastInsertRowid)
    }
    const e = b.expect
    if (!e || e.kind !== a.kind || Number(e.amount ?? 0) !== Number(a.amount ?? 0) || (e.to ?? null) !== (a.recipient?.address ?? null)) {
      await log('refused', 'changed since you confirmed', null)
      return c.json({ ok: false, status: 'refused', reason: 'that changed since you confirmed it. check the card again.', action: a }, 409)
    }
    if (!a.ok) { await log('refused', a.refuse ?? 'refused', null); return c.json({ ok: false, status: 'refused', reason: a.refuse, action: a }, 400) }
    const user = await walletOf(uid)
    const signer = loadAgentSigner()
    const W = wiflyContract()
    if (!sendingEnabled() || !user || !a.state.authorized || !W || !signer) {
      const why = !W ? 'contracts aren’t deployed yet' : process.env.AGENT_TX_ENABLED !== 'true' ? 'agent sending is off (AGENT_TX_ENABLED)' : !signer ? 'no agent signer configured' : !user ? 'no wallet on your account' : 'this agent isn’t authorised on your account'
      const id = await log('preview', why, null)
      return c.json({ ok: true, status: 'preview', reason: `nothing was sent: ${why}.`, id, action: a, state: await agentState(uid) })
    }
    const data = calldata(uid, user, a)
    try {
      await chainClient().call({ account: signer.address, to: W, data }) // simulate first: cap, balance and whitelist are enforced onchain too
      const hash = await signer.send(W, data)
      const rc = await chainClient().waitForTransactionReceipt({ hash })
      if (rc.status !== 'success') { const id = await log('failed', 'reverted', hash); return c.json({ ok: false, status: 'failed', reason: 'the transaction reverted', id, hash, action: a }, 502) }
      const id = await log('sent', null, hash)
      return c.json({ ok: true, status: 'sent', hash, id, action: a, state: await agentState(uid) })
    } catch (err) {
      const id = await log('failed', (err as Error).message.slice(0, 200), null)
      return c.json({ ok: false, status: 'failed', reason: 'the chain refused it (cap, balance or authorisation)', id, action: a }, 502)
    }
  })

  app.get('/api/agent/activity', async c => {
    const uid = needUser(c)
    const rows = await all<Record<string, unknown>>(`SELECT id, kind, command, recipient, recipient_address, amount, status, reason, tx_hash, created_at FROM agent_actions WHERE user_id = ? ORDER BY id DESC LIMIT 50`, [uid])
    return c.json({ items: rows.map(r => ({ id: Number(r.id), kind: r.kind, command: r.command, recipient: r.recipient, address: r.recipient_address, amount: Number(r.amount), status: r.status, reason: r.reason, txHash: r.tx_hash, at: Number(r.created_at) })) })
  })
}
