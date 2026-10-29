/**
 * DCA: recurring ETH -> WIF buys through the WiflyDCA contract (ABI in ./abi/wiflyDca.ts, from contracts/out).
 *
 * - Every user action is a tx from the user's OWN wallet (Privy embedded or external): createPlan (payable), topUp
 *   (payable), updatePlan, setPlanPaused, withdraw, withdrawAll, cancelPlan. No session signers. The contract lets these
 *   through at any time, even when the contract is paused or the user's Plus has lapsed.
 * - Live (DCA_CONTRACT_ADDRESS set): the chain is the source of truth. The DB only indexes plan ids per user, the
 *   "Paused, Plus expired" flag and fills read from Bought events in mined receipts. Fills are never invented.
 * - Preview (no contract): plans are saved for the demo with no tx hash and never fill.
 * - Keeper (DCA_KEEPER_ENABLED=true, default off; signer WIFLY_KEEPER_PRIVATE_KEY behind the AgentSigner interface):
 *   status(id) == 0 means ready. Before including a plan it re-reads the OWNER's Plus onchain (active or inside the
 *   5-day grace). Lapsed: not included, flagged "Paused, Plus expired" (withdraw/cancel still work; renewing Plus
 *   clears the flag on the next pass). Ready plans get min = max(quote * (1e4 - bps) / 1e4, floorWifOut(id)) from an
 *   off-chain V4 quote of amountPerBuy, then executeBatch(ids, mins), which emits Skipped instead of reverting.
 *   It warns (log + keeper status) when its ETH can't cover ~300k gas per buy, and doesn't send when it can't cover one.
 * - No platform fee. keeperTip defaults to 0.
 */
import type { Hono } from 'hono'
import { decodeEventLog, encodeFunctionData, formatEther, parseEther, type Address, type Hex } from 'viem'
import { needUser, type Env } from './auth'
import { chainClient } from './chain'
import { dcaContract } from './config'
import { all, one, run } from './db'
import { getPrice, quote } from './price'
import { fail, rateLimit } from './util'
import { envSigner, type AgentSigner } from './agent/signer'
import { WIFLY_DCA_ABI } from './abi/wiflyDca'
import { plusAccess, plusAccessForAddress, type PlusAccess } from './plusGate'
import { errLine } from './errline'

export const DCA_ABI = WIFLY_DCA_ABI
export const INTERVALS = { hour: 3600, day: 86400, week: 7 * 86400, month: 30 * 86400 } as const
export type Every = keyof typeof INTERVALS
export const SKIP_REASONS = ['ready', 'no plan', 'cancelled', 'paused', 'finished', 'not due', 'low balance', 'below the price floor', 'too much slippage', 'quote failed', 'short output', 'swap failed'] as const
export const GAS_PER_BUY = 300_000n
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MIN_INTERVAL = 3600, MAX_SLIPPAGE_BPS = 1000
const now = () => Date.now()
const HASH = /^0x[0-9a-fA-F]{64}$/

export type DcaDraft = {
  perBuy: { usd?: number; eth?: number }; every: Every; weekday: number | null; hour: number; minute: number
  summary: string
}

/** "buy $5 of WIF every Monday at 9am" -> a draft. Times are wall-clock in the user's zone; the client turns them into a timestamp. */
export function parseDca(raw: string): DcaDraft | null {
  const t = String(raw ?? '').toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim()
  if (!/\b(buy|dca|stack|accumulate)\b/.test(t) || !/\bwif\b/.test(t)) return null
  const amt = t.match(/\$\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?(usd|dollars?|eth)\b/)
  if (!amt) return null
  const perBuy = amt[1] ? { usd: Number(amt[1]) } : amt[3] === 'eth' ? { eth: Number(amt[2]) } : { usd: Number(amt[2]) }
  let every: Every = 'week', weekday: number | null = null
  const day = DAYS.findIndex(d => new RegExp(`\\b(every|each|on) ${d}s?\\b|\\b${d}s\\b`).test(t))
  if (day >= 0) { every = 'week'; weekday = day }
  else if (/\b(every|each) hour\b|\bhourly\b/.test(t)) every = 'hour'
  else if (/\b(every|each) day\b|\bdaily\b|\bevery morning\b|\bevery night\b/.test(t)) every = 'day'
  else if (/\b(every|each) month\b|\bmonthly\b/.test(t)) every = 'month'
  else if (/\b(every|each) week\b|\bweekly\b/.test(t)) every = 'week'
  else return null
  let hour = 9, minute = 0
  const tm = t.match(/\bat (\d{1,2})(?::(\d{2}))? ?(am|pm)?\b/)
  if (tm) {
    hour = Number(tm[1]) % 24; minute = Number(tm[2] ?? 0)
    if (tm[3] === 'pm' && hour < 12) hour += 12
    if (tm[3] === 'am' && hour === 12) hour = 0
    if (minute > 59) return null
  } else if (/\bnight\b/.test(t)) hour = 21
  const amount = perBuy.usd !== undefined ? `$${perBuy.usd}` : `${perBuy.eth} eth`
  const when = every === 'hour' ? 'every hour' : every === 'day' ? `every day at ${hh(hour, minute)}`
    : every === 'month' ? `every month at ${hh(hour, minute)}` : `every ${weekday !== null ? DAYS[weekday] : 'week'} at ${hh(hour, minute)}`
  if (!((perBuy.usd ?? perBuy.eth ?? 0) > 0)) return null
  return { perBuy, every, weekday, hour, minute, summary: `buy ${amount} of wif ${when}` }
}
const hh = (h: number, m: number) => `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`

export function nextBuyAt(firstAt: number, intervalS: number, at = now()) {
  if (at <= firstAt) return firstAt
  const step = intervalS * 1000
  return firstAt + Math.ceil((at - firstAt) / step) * step
}

type Row = { id: number; user_id: number; chain_plan_id: string | null; owner: string | null; deposit_eth: number; per_buy_eth: number; per_buy_usd: number | null
  interval_s: number; max_buys: number; first_at: number; tz: string | null; slippage_bps: number; min_wif_per_eth: number; keeper_tip_eth: number; status: string
  pause_reason: string | null; spent_eth: number; buys_done: number; last_fill_at: number | null; tx_hash: string | null; created_at: number }

/** One shape for the UI, live or preview. Amounts in ETH / WIF (numbers), times in ms. */
export type DcaPlanView = {
  id: number; chainPlanId: string | null; owner: string | null; balanceEth: number; perBuyEth: number; perBuyUsd: number | null; intervalS: number
  maxBuys: number; buysDone: number; buysLeft: number; startAt: number; lastBuyAt: number | null; nextAt: number | null
  minWifPerEth: number; slippageBps: number; keeperTipEth: number; spentEth: number; wifBought: number
  status: 'active' | 'paused' | 'plus_expired' | 'finished' | 'empty' | 'cancelled'; pauseReason: string | null
  tz: string | null; txHash: string | null; preview: boolean; createdAt: number
}

const previewView = (r: Row): DcaPlanView => {
  const left = Math.max(0, r.deposit_eth - r.spent_eth)
  const per = r.per_buy_eth + r.keeper_tip_eth
  let buysLeft = per > 0 ? Math.floor(left / per + 1e-9) : 0
  if (r.max_buys) buysLeft = Math.min(buysLeft, Math.max(0, r.max_buys - r.buys_done))
  const status: DcaPlanView['status'] = r.status === 'cancelled' ? 'cancelled' : r.status === 'paused' ? (r.pause_reason === 'plus_expired' ? 'plus_expired' : 'paused')
    : r.max_buys && r.buys_done >= r.max_buys ? 'finished' : buysLeft ? 'active' : 'empty'
  return {
    id: Number(r.id), chainPlanId: r.chain_plan_id, owner: r.owner, balanceEth: left, perBuyEth: r.per_buy_eth, perBuyUsd: r.per_buy_usd, intervalS: Number(r.interval_s),
    maxBuys: Number(r.max_buys), buysDone: Number(r.buys_done), buysLeft, startAt: Number(r.first_at), lastBuyAt: r.last_fill_at,
    nextAt: status === 'active' ? nextBuyAt(Number(r.first_at), Number(r.interval_s), Math.max(now(), (r.last_fill_at ?? 0) + 1)) : null,
    minWifPerEth: r.min_wif_per_eth, slippageBps: Number(r.slippage_bps), keeperTipEth: r.keeper_tip_eth, spentEth: r.spent_eth, wifBought: 0,
    status, pauseReason: status === 'paused' ? 'you paused it' : status === 'plus_expired' ? 'paused, plus expired' : null,
    tz: r.tz, txHash: r.tx_hash, preview: !r.tx_hash, createdAt: Number(r.created_at),
  }
}

export type ChainPlan = { owner: Address; startAt: number; lastBuyAt: number; maxSlippageBps: number; balance: bigint; amountPerBuy: bigint; keeperTip: bigint
  interval: number; maxBuys: number; buysDone: number; paused: boolean; cancelled: boolean; minWifPerEth: bigint; totalEthSpent: bigint; totalWifBought: bigint }

const e = (v: bigint) => Number(formatEther(v))
export function chainView(r: Row, p: ChainPlan, next: bigint, left: bigint): DcaPlanView {
  const plusExpired = r.pause_reason === 'plus_expired'
  const status: DcaPlanView['status'] = p.cancelled ? 'cancelled' : p.paused ? 'paused' : plusExpired ? 'plus_expired'
    : p.maxBuys && p.buysDone >= p.maxBuys ? 'finished' : left === 0n ? 'empty' : 'active'
  return {
    id: Number(r.id), chainPlanId: r.chain_plan_id, owner: p.owner, balanceEth: e(p.balance), perBuyEth: e(p.amountPerBuy), perBuyUsd: r.per_buy_usd, intervalS: p.interval,
    maxBuys: p.maxBuys, buysDone: p.buysDone, buysLeft: Number(left), startAt: p.startAt * 1000, lastBuyAt: p.lastBuyAt ? p.lastBuyAt * 1000 : null,
    nextAt: status === 'active' || status === 'plus_expired' ? Number(next) * 1000 : null,
    minWifPerEth: e(p.minWifPerEth), slippageBps: p.maxSlippageBps, keeperTipEth: e(p.keeperTip), spentEth: e(p.totalEthSpent), wifBought: e(p.totalWifBought),
    status, pauseReason: status === 'paused' ? 'you paused it' : status === 'plus_expired' ? 'paused, plus expired' : null,
    tz: r.tz, txHash: r.tx_hash, preview: false, createdAt: Number(r.created_at),
  }
}

export const dcaKeeperEnabled = () => process.env.DCA_KEEPER_ENABLED === 'true'
export const dcaLive = () => !!dcaContract()

async function walletsOf(uid: number): Promise<string[]> {
  const rows = await all<{ a: string | null }>(`SELECT address AS a FROM users WHERE id = ?1 UNION SELECT wallet AS a FROM privy_accounts WHERE user_id = ?1`, [uid])
  return rows.map(r => r.a?.toLowerCase()).filter((a): a is string => !!a && /^0x[0-9a-f]{40}$/.test(a))
}

async function readChainPlan(contract: Address, id: bigint): Promise<{ p: ChainPlan; next: bigint; left: bigint }> {
  const c = chainClient()
  const [p, next, left] = await Promise.all([
    c.readContract({ address: contract, abi: DCA_ABI, functionName: 'getPlan', args: [id] }),
    c.readContract({ address: contract, abi: DCA_ABI, functionName: 'nextBuyAt', args: [id] }),
    c.readContract({ address: contract, abi: DCA_ABI, functionName: 'buysLeft', args: [id] }),
  ])
  return { p: { ...p, startAt: Number(p.startAt), lastBuyAt: Number(p.lastBuyAt), interval: Number(p.interval), maxBuys: Number(p.maxBuys), buysDone: Number(p.buysDone), maxSlippageBps: Number(p.maxSlippageBps) } as ChainPlan, next, left }
}

/** Index any plans this user's wallets own onchain (plansOf) that the app hasn't seen yet. */
async function syncPlansOf(uid: number, contract: Address) {
  for (const w of await walletsOf(uid)) {
    const ids = await chainClient().readContract({ address: contract, abi: DCA_ABI, functionName: 'plansOf', args: [w as Address] }).catch(() => [] as readonly bigint[])
    for (const id of ids) await run(`INSERT INTO dca_plans (user_id, chain_plan_id, owner, deposit_eth, per_buy_eth, interval_s, first_at, slippage_bps, created_at, updated_at)
      VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?, ?) ON CONFLICT DO NOTHING`, [uid, id.toString(), w, now(), now()])
  }
}

export async function dcaState(uid: number) {
  const contract = dcaContract() as Address | ''
  const fillsQ = (where: string) => all<{ id: number; chain_plan_id: string; eth_in: number; wif_out: number; tx_hash: string; created_at: number }>(
    `SELECT f.* FROM dca_fills f JOIN dca_plans p ON p.chain_plan_id = f.chain_plan_id WHERE p.user_id = ? ${where} ORDER BY f.created_at DESC LIMIT 50`, [uid])
  let plans: DcaPlanView[] = []
  if (contract) {
    await syncPlansOf(uid, contract).catch(() => {})
    const rows = await all<Row>('SELECT * FROM dca_plans WHERE user_id = ? AND chain_plan_id IS NOT NULL ORDER BY id DESC LIMIT 30', [uid])
    plans = (await Promise.all(rows.map(async r => {
      try { const { p, next, left } = await readChainPlan(contract, BigInt(r.chain_plan_id!)); return chainView(r, p, next, left) } catch { return null }
    }))).filter((x): x is DcaPlanView => !!x)
  } else {
    plans = (await all<Row>('SELECT * FROM dca_plans WHERE user_id = ? AND chain_plan_id IS NULL ORDER BY id DESC LIMIT 30', [uid])).map(previewView)
  }
  const fills = contract ? await fillsQ('') : []
  const keeper = await keeperStatus()
  return {
    live: !!contract, contract: contract || null, abi: 'WiflyDCA' as const, keeper,
    plans: plans.filter(p => p.status !== 'cancelled'), closed: plans.filter(p => p.status === 'cancelled').slice(0, 10),
    fills: fills.map(f => ({ id: Number(f.id), chainPlanId: f.chain_plan_id, planId: plans.find(p => p.chainPlanId === f.chain_plan_id)?.id ?? null, ethIn: f.eth_in, wifOut: f.wif_out, price: f.eth_in ? f.wif_out / f.eth_in : 0, txHash: f.tx_hash, at: Number(f.created_at) })),
  }
}

type CreateBody = { depositEth?: number; perBuyEth?: number; perBuyUsd?: number; intervalS?: number; maxBuys?: number; firstAt?: number; tz?: string
  slippageBps?: number; minWifPerEth?: number; txHash?: string }
type ActionBody = { txHash?: string; amountEth?: number; perBuyEth?: number; intervalS?: number; maxBuys?: number; slippageBps?: number; minWifPerEth?: number }

/** Reads a mined createPlan receipt and returns the PlanCreated it emitted (checked against the user's wallets). */
async function planCreatedIn(contract: Address, hash: Hex) {
  const rc = await chainClient().getTransactionReceipt({ hash }).catch(() => null)
  if (!rc) fail(409, 'that transaction isn’t mined yet. try again in a few seconds')
  if (rc!.status !== 'success') fail(400, 'that transaction reverted')
  for (const l of rc!.logs) {
    if (l.address.toLowerCase() !== contract.toLowerCase()) continue
    try { const d = decodeEventLog({ abi: DCA_ABI, data: l.data, topics: l.topics }); if (d.eventName === 'PlanCreated') return d.args } catch { /* other event */ }
  }
  return fail(400, 'no PlanCreated in that transaction')
}

export function registerDca(app: Hono<Env>) {
  app.get('/api/dca', async c => c.json(await dcaState(needUser(c))))

  app.post('/api/dca/parse', async c => {
    const uid = needUser(c)
    await rateLimit(`dp:${uid}`, 60, 60_000)
    const { text } = await c.req.json<{ text?: string }>().catch(() => ({ text: '' }))
    const d = parseDca(String(text ?? '').slice(0, 200))
    return c.json(d ? { ok: true, draft: d } : { ok: false, reason: 'try “buy $5 of wif every monday at 9am”' })
  })

  /** Live: index the plan from the mined createPlan receipt (owner must be one of the user's wallets). Preview: save the plan. */
  app.post('/api/dca/plans', async c => {
    const uid = needUser(c)
    await rateLimit(`dc:${uid}`, 10, 60_000)
    const b = await c.req.json<CreateBody>().catch(() => ({} as CreateBody))
    const tz = String(b.tz ?? '').slice(0, 64) || null
    const contract = dcaContract() as Address | ''
    if (contract) {
      if (!HASH.test(b.txHash ?? '')) fail(400, 'send createPlan from your wallet first')
      const ev = await planCreatedIn(contract, b.txHash as Hex)
      if (!(await walletsOf(uid)).includes(ev.owner.toLowerCase())) fail(403, 'that plan belongs to another wallet')
      await run(`INSERT INTO dca_plans (user_id, chain_plan_id, owner, deposit_eth, per_buy_eth, per_buy_usd, interval_s, max_buys, first_at, tz, slippage_bps, min_wif_per_eth, keeper_tip_eth, tx_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [uid, ev.planId.toString(), ev.owner.toLowerCase(), e(ev.deposit), e(ev.amountPerBuy), b.perBuyUsd ? Number(b.perBuyUsd) : null, Number(ev.interval), Number(ev.maxBuys),
          Number(ev.startAt) * 1000, tz, Number(ev.maxSlippageBps), e(ev.minWifPerEth), e(ev.keeperTip), b.txHash as string, now(), now()])
      return c.json(await dcaState(uid), 201)
    }
    const dep = Number(b.depositEth), per = Number(b.perBuyEth), iv = Math.round(Number(b.intervalS)), first = Math.round(Number(b.firstAt))
    const slip = Math.round(Number(b.slippageBps ?? 100)), maxBuys = Math.max(0, Math.round(Number(b.maxBuys ?? 0)))
    if (!(dep > 0) || dep > 1000) fail(400, 'deposit between 0 and 1,000 eth')
    if (!(per > 0) || per > dep) fail(400, 'the amount per buy has to fit in the deposit')
    if (!(iv >= MIN_INTERVAL) || iv > 366 * 86400) fail(400, 'buy at most once an hour')
    if (!(first > now() - 60_000) || first > now() + 366 * 86400_000) fail(400, 'pick a first buy time in the next year')
    if (!(slip >= 0 && slip <= MAX_SLIPPAGE_BPS)) fail(400, 'the slippage guard is up to 10%')
    const floor = Number(b.minWifPerEth ?? 0)
    if (!slip && !(floor > 0)) fail(400, 'set a slippage guard or a price floor')
    const r = await run(`INSERT INTO dca_plans (user_id, deposit_eth, per_buy_eth, per_buy_usd, interval_s, max_buys, first_at, tz, slippage_bps, min_wif_per_eth, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [uid, dep, per, b.perBuyUsd ? Number(b.perBuyUsd) : null, iv, maxBuys, first, tz, slip, floor > 0 ? floor : 0, now(), now()])
    await run('INSERT INTO dca_actions (plan_id, action, tx_hash, created_at) VALUES (?, ?, NULL, ?)', [Number(r.lastInsertRowid), 'create', now()])
    return c.json(await dcaState(uid), 201)
  })

  /**
   * pause / resume (setPlanPaused), edit (updatePlan), topup (topUp), withdraw (withdraw / withdrawAll), cancel (cancelPlan).
   * Live: the user's wallet already sent it; we log the hash and re-read the chain. These always work, Plus or not;
   * only resuming a "Paused, Plus expired" plan needs Plus again (the keeper wouldn't buy for it anyway).
   */
  app.post('/api/dca/plans/:id/:action{pause|resume|edit|topup|withdraw|cancel}', async c => {
    const uid = needUser(c)
    await rateLimit(`dc:${uid}`, 30, 60_000)
    const id = Number(c.req.param('id')), action = c.req.param('action')
    const row = await one<Row>('SELECT * FROM dca_plans WHERE id = ? AND user_id = ?', [id, uid])
    if (!row) fail(404, 'no such plan')
    const b = await c.req.json<ActionBody>().catch(() => ({} as ActionBody))
    const live = !!row!.chain_plan_id
    if (live && !HASH.test(b.txHash ?? '')) fail(400, `send ${action} from your wallet first`)
    if (action === 'resume' && row!.pause_reason === 'plus_expired' && !(await plusAccess(uid, true)).ok) fail(403, 'scheduled buys need wifly plus. renew plus to resume, or withdraw your eth any time.')
    if (live) {
      if (action === 'resume' || action === 'cancel') await run('UPDATE dca_plans SET pause_reason = NULL, updated_at = ? WHERE id = ?', [now(), id])
    } else {
      if (row!.status === 'cancelled') fail(409, 'that plan is already cancelled')
      const set = (sql: string, args: (string | number)[]) => run(`UPDATE dca_plans SET ${sql}, updated_at = ? WHERE id = ?`, [...args, now(), id])
      const left = Math.max(0, row!.deposit_eth - row!.spent_eth)
      if (action === 'pause') await set(`status = 'paused', pause_reason = 'user'`, [])
      if (action === 'resume') await set(`status = 'active', pause_reason = NULL`, [])
      if (action === 'cancel') await set(`status = 'cancelled', deposit_eth = spent_eth`, [])
      if (action === 'topup') { const a = Number(b.amountEth); if (!(a > 0) || a > 1000) fail(400, 'top up between 0 and 1,000 eth'); await set('deposit_eth = deposit_eth + ?', [a]) }
      if (action === 'withdraw') { const a = b.amountEth === undefined ? left : Number(b.amountEth); if (!(a > 0) || a > left + 1e-12) fail(400, `you can withdraw up to ${left} eth`); await set('deposit_eth = deposit_eth - ?', [a]) }
      if (action === 'edit') {
        const per = Number(b.perBuyEth ?? row!.per_buy_eth), iv = Math.round(Number(b.intervalS ?? row!.interval_s)), slip = Math.round(Number(b.slippageBps ?? row!.slippage_bps))
        if (!(per > 0)) fail(400, 'enter an amount per buy')
        if (!(iv >= MIN_INTERVAL)) fail(400, 'buy at most once an hour')
        if (!(slip >= 0 && slip <= MAX_SLIPPAGE_BPS)) fail(400, 'the slippage guard is up to 10%')
        await set('per_buy_eth = ?, interval_s = ?, slippage_bps = ?, max_buys = ?', [per, iv, slip, Math.max(0, Math.round(Number(b.maxBuys ?? row!.max_buys)))])
      }
    }
    await run('INSERT INTO dca_actions (plan_id, action, tx_hash, created_at) VALUES (?, ?, ?, ?)', [id, action, b.txHash ?? null, now()])
    return c.json(await dcaState(uid))
  })

  app.get('/api/dca/keeper', async c => c.json(await keeperStatus()))
}

// ------------------------------------------------------------------ keeper

export type Bought = { planId: bigint; owner: Address; ethIn: bigint; wifOut: bigint; logIndex: number }
export type DcaChain = {
  nextPlanId(): Promise<bigint>
  status(id: bigint): Promise<number>
  plan(id: bigint): Promise<ChainPlan>
  floorWifOut(id: bigint): Promise<bigint>
  /** Off-chain V4 quote: WIF out for `ethIn`. */
  quote(ethIn: bigint): Promise<bigint>
  /** Simulates, then sends executeBatch. null = the simulation buys nothing (0 executed), so nothing is sent. */
  executeBatch(ids: bigint[], mins: bigint[]): Promise<Hex | null>
  receipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; bought: Bought[]; skipped: { planId: bigint; reason: number }[] }>
  keeperBalance(): Promise<bigint>
  gasPrice(): Promise<bigint>
}
export type DcaRun = { planId: string; action: 'bought' | 'skipped' | 'plus_expired' | 'failed' | 'low_balance'; txHash?: Hex; detail?: string }
export type OwnerPlus = (owner: Address) => Promise<PlusAccess>

let lastKeeper: { at: number; balanceEth: number | null; neededEth: number | null; low: boolean; address: string | null } = { at: 0, balanceEth: null, neededEth: null, low: false, address: null }
async function keeperStatus() {
  const runs = await all<{ plan_id: number; action: string; tx_hash: string | null; created_at: number }>('SELECT plan_id, action, tx_hash, created_at FROM dca_actions WHERE action LIKE ? ORDER BY id DESC LIMIT 10', ['keeper%'])
  // enabled = the keeper is really running in this process (flag on AND contract AND signer), not just the env flag
  // ready = the onchain preflight passed (allowed keeper, contract not paused): only then do plans really get bought
  return { enabled: keeperState === 'started' && keeperReady.ok, flag: dcaKeeperEnabled(), state: keeperState, ready: keeperState === 'started' && keeperReady.ok,
    waiting: keeperState === 'started' && !keeperReady.ok ? keeperReady.reason : null, live: dcaLive(), ...lastKeeper, runs }
}

const BATCH = 20
// per-plan keeper backoff: a plan that is skipped or fails waits 10 min, then 20, 40 ... up to 6h. a buy clears it.
export const BACKOFF_BASE_MS = 10 * 60_000, BACKOFF_MAX_MS = 6 * 3600_000
async function backoffUntil(id: bigint): Promise<number> {
  return Number((await one<{ until_at: number }>('SELECT until_at FROM dca_backoff WHERE chain_plan_id = ?', [id.toString()]))?.until_at ?? 0)
}
async function backOff(id: string, reason: string, at: number) {
  const prev = await one<{ step_ms: number }>('SELECT step_ms FROM dca_backoff WHERE chain_plan_id = ?', [id])
  const step = prev ? Math.min(BACKOFF_MAX_MS, Number(prev.step_ms) * 2) : BACKOFF_BASE_MS
  await run(`INSERT INTO dca_backoff (chain_plan_id, until_at, step_ms, reason, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (chain_plan_id) DO UPDATE SET until_at = excluded.until_at, step_ms = excluded.step_ms, reason = excluded.reason, updated_at = excluded.updated_at`, [id, at + step, step, reason.slice(0, 120), at])
}
const clearBackoff = (id: string) => run('DELETE FROM dca_backoff WHERE chain_plan_id = ?', [id])
/** read-only view for tests and status: the backoff row for one onchain plan, if any. */
export const dcaBackoff = (id: string) => one<{ until_at: number; step_ms: number; reason: string }>('SELECT until_at, step_ms, reason FROM dca_backoff WHERE chain_plan_id = ?', [id])
/** One pass over every plan on the contract. Never invents a fill: fills come from Bought logs in a successful receipt. */
export async function runDcaKeeperOnce(chain: DcaChain, ownerPlus: OwnerPlus = a => plusAccessForAddress(a), at = now(), keeperAddress: string | null = null): Promise<DcaRun[]> {
  const out: DcaRun[] = []
  const last = await chain.nextPlanId()
  const ready: { id: bigint; min: bigint }[] = []
  const maxScan = BigInt(Math.max(1, Number(process.env.DCA_KEEPER_MAX_SCAN || 5000)))
  for (let id = last > maxScan ? last - maxScan : 1n; id < last; id++) {
    if ((await chain.status(id)) !== 0) continue
    if ((await backoffUntil(id)) > at) continue // backing off after a skip or fail: no reads past this, nothing sent
    const p = await chain.plan(id)
    // Plus gate, read fresh before every scheduled buy (active or inside grace). Unreadable: skip quietly, retry next pass.
    const plus = await ownerPlus(p.owner).catch(() => ({ ok: false, state: 'unknown' } as PlusAccess))
    if (!plus.ok) {
      if (plus.state !== 'unknown') {
        await run(`UPDATE dca_plans SET pause_reason = 'plus_expired', updated_at = ? WHERE chain_plan_id = ? AND (pause_reason IS NULL OR pause_reason != 'plus_expired')`, [at, id.toString()])
        out.push({ planId: id.toString(), action: 'plus_expired', detail: 'paused, plus expired' })
      } else out.push({ planId: id.toString(), action: 'skipped', detail: 'couldn’t read plus onchain' })
      continue
    }
    await run(`UPDATE dca_plans SET pause_reason = NULL, updated_at = ? WHERE chain_plan_id = ? AND pause_reason = 'plus_expired'`, [at, id.toString()])
    try {
      const [q, floor] = await Promise.all([chain.quote(p.amountPerBuy), chain.floorWifOut(id)])
      const bySlip = p.maxSlippageBps ? q * BigInt(10_000 - p.maxSlippageBps) / 10_000n : 0n
      const min = bySlip > floor ? bySlip : floor
      if (min === 0n) { out.push({ planId: id.toString(), action: 'skipped', detail: 'no price guard' }); await backOff(id.toString(), 'no price guard', at); continue }
      // the floor (or guard) asks for more WIF than the market gives: the contract would only emit Skipped, so don't pay gas for it
      if (min > q) { out.push({ planId: id.toString(), action: 'skipped', detail: 'below the price floor' }); await backOff(id.toString(), 'below the price floor', at); continue }
      ready.push({ id, min })
    } catch (err) { out.push({ planId: id.toString(), action: 'skipped', detail: `quote failed: ${errLine(err, 80)}` }); await backOff(id.toString(), 'quote failed', at) }
  }
  if (!ready.length) return log(out, at)
  // gas: ~300k per buy. Warn below 2x what this pass needs; don't send when it can't cover one buy.
  const [bal, gp] = await Promise.all([chain.keeperBalance(), chain.gasPrice()])
  const need = GAS_PER_BUY * gp * BigInt(ready.length)
  const low = bal < need * 2n
  lastKeeper = { at, balanceEth: e(bal), neededEth: e(need), low, address: keeperAddress }
  if (low) console.warn(`[dca-keeper] LOW BALANCE: keeper has ${formatEther(bal)} eth, this pass needs about ${formatEther(need)} eth (${ready.length} buys x ~300k gas). top up the keeper wallet.`)
  if (bal < GAS_PER_BUY * gp) { for (const r of ready) out.push({ planId: r.id.toString(), action: 'low_balance', detail: 'keeper is out of gas' }); return log(out, at) }
  for (let i = 0; i < ready.length; i += BATCH) {
    const chunk = ready.slice(i, i + BATCH)
    try {
      const hash = await chain.executeBatch(chunk.map(r => r.id), chunk.map(r => r.min))
      if (!hash) { for (const r of chunk) { out.push({ planId: r.id.toString(), action: 'skipped', detail: 'nothing to buy, not sent' }); await backOff(r.id.toString(), 'simulated 0', at) } continue }
      const rc = await chain.receipt(hash)
      if (rc.status !== 'success') { for (const r of chunk) { out.push({ planId: r.id.toString(), action: 'failed', txHash: hash, detail: 'batch reverted' }); await backOff(r.id.toString(), 'batch reverted', at) } continue }
      for (const b of rc.bought) {
        await run(`INSERT INTO dca_fills (plan_id, chain_plan_id, owner, eth_in, wif_out, tx_hash, log_index, created_at)
          VALUES ((SELECT id FROM dca_plans WHERE chain_plan_id = ?1), ?1, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          [b.planId.toString(), b.owner.toLowerCase(), e(b.ethIn), e(b.wifOut), hash, b.logIndex, at])
        out.push({ planId: b.planId.toString(), action: 'bought', txHash: hash })
        await clearBackoff(b.planId.toString())
      }
      for (const s of rc.skipped) { const why = SKIP_REASONS[s.reason] ?? `reason ${s.reason}`; out.push({ planId: s.planId.toString(), action: 'skipped', txHash: hash, detail: why }); await backOff(s.planId.toString(), why, at) }
    } catch (err) { for (const r of chunk) { out.push({ planId: r.id.toString(), action: 'failed', detail: errLine(err, 160) }); await backOff(r.id.toString(), 'send failed', at) } }
  }
  return log(out, at)
}
async function log(out: DcaRun[], at: number) {
  for (const o of out) {
    const row = await one<{ id: number }>('SELECT id FROM dca_plans WHERE chain_plan_id = ?', [o.planId])
    if (row) await run('INSERT INTO dca_actions (plan_id, action, tx_hash, created_at) VALUES (?, ?, ?, ?)', [row.id, `keeper:${o.action}`, o.txHash ?? null, at])
  }
  return out
}

export function viemDcaChain(contract: Address, signer: AgentSigner): DcaChain {
  const c = chainClient()
  const read = <T>(functionName: string, args: unknown[] = []) => c.readContract({ address: contract, abi: DCA_ABI, functionName: functionName as never, args: args as never }) as Promise<T>
  return {
    nextPlanId: () => read<bigint>('nextPlanId'),
    status: async id => Number(await read<number>('status', [id])),
    plan: async id => { const p = await read<ChainPlan>('getPlan', [id]); return { ...p, startAt: Number(p.startAt), lastBuyAt: Number(p.lastBuyAt), interval: Number(p.interval), maxBuys: Number(p.maxBuys), buysDone: Number(p.buysDone), maxSlippageBps: Number(p.maxSlippageBps) } },
    floorWifOut: id => read<bigint>('floorWifOut', [id]),
    quote: async ethIn => BigInt((await quote('eth2wif', ethIn)).amountOut),
    executeBatch: async (ids, mins) => {
      const { result } = await c.simulateContract({ address: contract, abi: DCA_ABI, functionName: 'executeBatch', args: [ids, mins], account: signer.address })
      if (BigInt(result as bigint) === 0n) return null // every plan would just emit Skipped: don't pay gas for that
      return signer.send(contract, encodeFunctionData({ abi: DCA_ABI, functionName: 'executeBatch', args: [ids, mins] }))
    },
    receipt: async hash => {
      const rc = await c.waitForTransactionReceipt({ hash, timeout: 120_000 })
      const bought: Bought[] = [], skipped: { planId: bigint; reason: number }[] = []
      for (const l of rc.logs) {
        if (l.address.toLowerCase() !== contract.toLowerCase()) continue
        try {
          const d = decodeEventLog({ abi: DCA_ABI, data: l.data, topics: l.topics })
          if (d.eventName === 'Bought') bought.push({ planId: d.args.planId, owner: d.args.owner, ethIn: d.args.ethIn, wifOut: d.args.wifOut, logIndex: Number(l.logIndex) })
          if (d.eventName === 'Skipped') skipped.push({ planId: d.args.planId, reason: Number(d.args.reason) })
        } catch { /* other event */ }
      }
      return { status: rc.status, bought, skipped }
    },
    keeperBalance: () => c.getBalance({ address: signer.address }),
    gasPrice: () => c.getGasPrice(),
  }
}

let dcaSigner: AgentSigner | null | undefined
export function setDcaKeeperSigner(s: AgentSigner | null | undefined) { dcaSigner = s }
/** WIFLY_KEEPER_PRIVATE_KEY (set in Railway; never logged or returned). Only pays gas for executeBatch:
 *  the contract sends WIF straight to plan owners. KEEPER_SIGNER=kms is the placeholder for a vault signer. */
export function loadDcaKeeperSigner(): AgentSigner | null {
  if (dcaSigner !== undefined) return dcaSigner
  // WIFLY_KEEPER_PRIVATE_KEY first; else the week keeper's KEEPER_PRIVATE_KEY (both are meant for the keeper wallet
  // 0xfE72…, which already has setKeeper on WiflyDCA). Never the agent key: it has no keeper role.
  dcaSigner = (process.env.KEEPER_SIGNER || 'env').toLowerCase() === 'kms' ? null
    : process.env.WIFLY_KEEPER_PRIVATE_KEY ? envSigner('WIFLY_KEEPER_PRIVATE_KEY', 'dca-keeper') : envSigner('KEEPER_PRIVATE_KEY', 'dca-keeper')
  return dcaSigner
}

let timer: ReturnType<typeof setInterval> | null = null
let keeperState: 'off' | 'no-contract' | 'no-signer' | 'started' | 'not-started' = 'not-started'
/** Onchain preflight, re-read every pass: the signer must be an allowed keeper and the contract unpaused, else nothing is sent. */
let keeperReady: { ok: boolean; reason: string | null } = { ok: false, reason: 'not checked yet' }
export type KeeperPreflight = { isKeeper(addr: Address): Promise<boolean>; paused(): Promise<boolean> }
export async function dcaPreflight(pf: KeeperPreflight, addr: Address): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const [k, p] = await Promise.all([pf.isKeeper(addr), pf.paused()])
    if (!k) return { ok: false, reason: `keeper ${addr} is not allowed on WiflyDCA yet: the owner has to call setKeeper(${addr}, true)` }
    if (p) return { ok: false, reason: 'WiflyDCA is paused by the owner' }
    return { ok: true, reason: null }
  } catch (err) { return { ok: false, reason: `couldn’t read WiflyDCA: ${errLine(err, 80)}` } }
}
export function setKeeperReadyForTest(v: { ok: boolean; reason: string | null }, state: typeof keeperState = 'started') { keeperReady = v; keeperState = state }
/** Called from server.ts. Off unless DCA_KEEPER_ENABLED=true and the contract + keeper signer are set. */
export function startDcaKeeper(): 'off' | 'no-contract' | 'no-signer' | 'started' {
  if (!dcaKeeperEnabled()) { console.log(`[dca-keeper] off (DCA_KEEPER_ENABLED=${JSON.stringify(process.env.DCA_KEEPER_ENABLED ?? '')}, only "true" turns it on)`); return (keeperState = 'off') }
  const contract = dcaContract()
  if (!contract) { console.log('[dca-keeper] off: DCA_KEEPER_ENABLED=true but DCA_CONTRACT_ADDRESS not set'); return (keeperState = 'no-contract') }
  const signer = loadDcaKeeperSigner()
  if (!signer) { console.log('[dca-keeper] off: DCA_KEEPER_ENABLED=true but neither WIFLY_KEEPER_PRIVATE_KEY nor KEEPER_PRIVATE_KEY is set'); return (keeperState = 'no-signer') }
  keeperState = 'started'
  const chain = viemDcaChain(contract as Address, signer)
  const c = chainClient()
  const pf: KeeperPreflight = {
    isKeeper: a => c.readContract({ address: contract as Address, abi: DCA_ABI, functionName: 'isKeeper', args: [a] }) as Promise<boolean>,
    paused: () => c.readContract({ address: contract as Address, abi: DCA_ABI, functionName: 'paused' }) as Promise<boolean>,
  }
  let busy = false
  const tick = async () => {
    if (busy) return; busy = true
    try {
      const was = keeperReady
      keeperReady = await dcaPreflight(pf, signer.address)
      if (!keeperReady.ok) { if (keeperReady.reason !== was.reason) console.log(`[dca-keeper] waiting: ${keeperReady.reason}`); return }
      if (!was.ok) console.log(`[dca-keeper] ready: ${signer.address} is an allowed keeper`)
      const r = await runDcaKeeperOnce(chain, undefined, now(), signer.address); for (const x of r) console.log(`[dca-keeper] plan ${x.planId}: ${x.action}${x.detail ? ` (${x.detail})` : ''}${x.txHash ? ` tx ${x.txHash}` : ''}`) }
    catch (err) { console.log('[dca-keeper] pass failed:', errLine(err)) } finally { busy = false }
  }
  timer = setInterval(tick, Math.max(30_000, Number(process.env.DCA_KEEPER_INTERVAL_MS || 60_000)))
  timer.unref?.()
  void tick()
  console.log(`[dca-keeper] on (DCA_KEEPER_ENABLED=true): signer ${signer.address} (needs setKeeper(${signer.address}, true) on WiflyDCA). set DCA_KEEPER_ENABLED=false to turn it off`)
  return 'started'
}
export function stopDcaKeeper() { if (timer) clearInterval(timer); timer = null; if (keeperState === 'started') keeperState = 'off' }
export { parseEther }
