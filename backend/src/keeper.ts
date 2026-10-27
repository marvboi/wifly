/**
 * Weekly keeper: closes ended pay-to-vote weeks on Wifly by calling the permissionless
 * `finalizeEpoch(uint256 epoch, address winner)` (winner must equal `epochs(epoch).leader`).
 *
 * - Off by default: WEEK_KEEPER_ENABLED=false (like TX_ENABLED / AGENT_TX_ENABLED). Needs WIFLY_CONTRACT_ADDRESS and a signer.
 * - Signer: loadKeeperSigner() (KEEPER_PRIVATE_KEY, else the agent signer; KMS-swappable). The key is never hardcoded or logged.
 * - Idempotent: reads `epochs(e)` first and skips finalized weeks; simulates before sending, so a replica that loses the
 *   race sees AlreadyFinalized and skips instead of burning gas. Weeks with no votes are skipped (the pot rolls over).
 * - feev2: finalizeEpoch pays out payablePot() (epochPot minus this week's inflow); the keeper logs that amount.
 * - Retries with exponential backoff, logs every run to keeper_runs and stdout.
 * - Schedule: setInterval every WEEK_KEEPER_INTERVAL_MS (default 10 min). The weekly boundary is on-chain
 *   (EPOCH_LENGTH = 7 days, epoch = block.timestamp / 7 days), so a frequent idempotent tick is simpler than a cron expression.
 */
import { encodeFunctionData, formatUnits, parseAbi, type Address, type Hex } from 'viem'
import { chainClient } from './chain'
import { wiflyContract } from './config'
import { all, run } from './db'
import { loadKeeperSigner, type AgentSigner } from './agent/signer'

export const KEEPER_ABI = parseAbi([
  'function currentEpoch() view returns (uint256)',
  'function epochEndsAt(uint256 epoch) pure returns (uint256)',
  'function epochs(uint256) view returns (address leader, bool finalized, uint256 leaderVotes, uint256 voterPool, uint256 voterPoolLeft)',
  'function payablePot() view returns (uint256)', // feev2: what finalizeEpoch splits now (excludes this week's inflow)
  'function finalizeEpoch(uint256 epoch, address winner)',
  'error EpochNotOver()', 'error AlreadyFinalized()', 'error NoVotes()', 'error NotLeader(address leader)',
])
const ZERO = '0x0000000000000000000000000000000000000000'

export type EpochInfo = { leader: Address; finalized: boolean; leaderVotes: bigint }
export type KeeperChain = {
  currentEpoch(): Promise<bigint>
  epoch(e: bigint): Promise<EpochInfo>
  /** Wei that finalizeEpoch would split right now. Optional: only used for the log line. */
  payablePot?(): Promise<bigint>
  /** Throws (with the revert name in the message) when the call would revert. */
  simulateFinalize(e: bigint, winner: Address): Promise<void>
  sendFinalize(e: bigint, winner: Address): Promise<Hex>
  waitReceipt(hash: Hex): Promise<'success' | 'reverted'>
}
export type KeeperResult = { epoch: number; action: 'finalized' | 'already-closed' | 'no-votes' | 'not-over' | 'failed'; txHash?: Hex; attempts: number; detail?: string }
export type KeeperOpts = { lookback?: number; retries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void>; log?: (r: KeeperResult) => Promise<void> | void }

const SKIP_ERRORS: Record<string, KeeperResult['action']> = { AlreadyFinalized: 'already-closed', NoVotes: 'no-votes', EpochNotOver: 'not-over' }
const skipOf = (e: unknown) => { const m = String((e as Error)?.message ?? e); for (const k of Object.keys(SKIP_ERRORS)) if (m.includes(k)) return SKIP_ERRORS[k]; return null }

/** One keeper pass: every ended week in the lookback window, oldest first. */
export async function runKeeperOnce(chain: KeeperChain, o: KeeperOpts = {}): Promise<KeeperResult[]> {
  const lookback = BigInt(o.lookback ?? 4), retries = o.retries ?? 4, base = o.baseDelayMs ?? 2000
  const sleep = o.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const cur = await chain.currentEpoch()
  const out: KeeperResult[] = []
  const from = cur > lookback ? cur - lookback : 0n
  for (let e = from; e < cur; e++) {
    let res: KeeperResult | null = null
    let attempts = 0
    while (!res) {
      attempts++
      try {
        const info = await chain.epoch(e) // re-read every attempt: idempotent even if someone else closed it meanwhile
        if (info.finalized) { res = { epoch: Number(e), action: 'already-closed', attempts }; break }
        if (info.leader.toLowerCase() === ZERO) { res = { epoch: Number(e), action: 'no-votes', attempts, detail: 'nobody voted; the pot rolls over' }; break }
        const pot = await chain.payablePot?.().catch(() => undefined)
        await chain.simulateFinalize(e, info.leader)
        const hash = await chain.sendFinalize(e, info.leader)
        const st = await chain.waitReceipt(hash)
        if (st !== 'success') throw new Error(`finalizeEpoch reverted (${hash})`)
        res = { epoch: Number(e), action: 'finalized', txHash: hash, attempts, detail: `winner ${info.leader}${pot !== undefined ? `, splits ${formatUnits(pot, 18)} WIF` : ''}` }
      } catch (err) {
        const skip = skipOf(err)
        if (skip) { res = { epoch: Number(e), action: skip, attempts }; break }
        if (attempts > retries) { res = { epoch: Number(e), action: 'failed', attempts, detail: String((err as Error)?.message ?? err).slice(0, 300) }; break }
        await sleep(base * 2 ** (attempts - 1))
      }
    }
    // only weeks with something to report are logged to keep the table small; already-closed is quiet
    if (res.action !== 'already-closed') await o.log?.(res)
    out.push(res)
  }
  return out
}

export function viemKeeperChain(contract: Address, signer: AgentSigner): KeeperChain {
  const c = chainClient()
  return {
    currentEpoch: () => c.readContract({ address: contract, abi: KEEPER_ABI, functionName: 'currentEpoch' }),
    epoch: async e => { const [leader, finalized, leaderVotes] = await c.readContract({ address: contract, abi: KEEPER_ABI, functionName: 'epochs', args: [e] }); return { leader, finalized, leaderVotes } },
    payablePot: () => c.readContract({ address: contract, abi: KEEPER_ABI, functionName: 'payablePot' }),
    simulateFinalize: async (e, w) => { await c.simulateContract({ address: contract, abi: KEEPER_ABI, functionName: 'finalizeEpoch', args: [e, w], account: signer.address }) },
    sendFinalize: (e, w) => signer.send(contract, encodeFunctionData({ abi: KEEPER_ABI, functionName: 'finalizeEpoch', args: [e, w] })),
    waitReceipt: async h => (await c.waitForTransactionReceipt({ hash: h, timeout: 120_000 })).status,
  }
}

export const keeperEnabled = () => process.env.WEEK_KEEPER_ENABLED === 'true'
export const keeperIntervalMs = () => Math.max(60_000, Number(process.env.WEEK_KEEPER_INTERVAL_MS || 600_000))

async function logRun(r: KeeperResult) {
  console.log(`[keeper] epoch ${r.epoch}: ${r.action}${r.txHash ? ` tx ${r.txHash}` : ''}${r.detail ? ` (${r.detail})` : ''} after ${r.attempts} attempt(s)`)
  await run('INSERT INTO keeper_runs (epoch, action, detail, tx_hash, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?)', [r.epoch, r.action, r.detail ?? null, r.txHash ?? null, r.attempts, Date.now()])
}

let timer: ReturnType<typeof setInterval> | null = null
let running = false
/** Called from server.ts. Does nothing unless WEEK_KEEPER_ENABLED=true and the contract + signer are configured. */
export function startWeekKeeper(): 'off' | 'no-contract' | 'no-signer' | 'started' {
  if (!keeperEnabled()) { console.log('[keeper] off (WEEK_KEEPER_ENABLED is not true)'); return 'off' }
  const contract = wiflyContract()
  if (!contract) { console.log('[keeper] off: WIFLY_CONTRACT_ADDRESS not set'); return 'no-contract' }
  const signer = loadKeeperSigner()
  if (!signer) { console.log('[keeper] off: no signer (KEEPER_PRIVATE_KEY / AGENT_PRIVATE_KEY unset)'); return 'no-signer' }
  const chain = viemKeeperChain(contract as Address, signer)
  const tick = async () => {
    if (running) return
    running = true
    try { await runKeeperOnce(chain, { log: logRun }) } catch (e) { await logRun({ epoch: -1, action: 'failed', attempts: 1, detail: String((e as Error)?.message ?? e).slice(0, 300) }).catch(() => {}) } finally { running = false }
  }
  timer = setInterval(tick, keeperIntervalMs())
  timer.unref?.()
  void tick()
  console.log(`[keeper] on: signer ${signer.address} (${signer.kind}), every ${keeperIntervalMs() / 1000}s`)
  return 'started'
}
export function stopWeekKeeper() { if (timer) clearInterval(timer); timer = null }

export async function keeperStatus() {
  const runs = await all<{ epoch: number; action: string; detail: string | null; tx_hash: string | null; attempts: number; created_at: number }>('SELECT epoch, action, detail, tx_hash, attempts, created_at FROM keeper_runs ORDER BY id DESC LIMIT 10')
  return { enabled: keeperEnabled(), intervalMs: keeperIntervalMs(), running: !!timer, runs }
}
