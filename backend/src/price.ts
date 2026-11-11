/**
 * WIF price service. Clients only ever talk to us; we talk to the chain (and public APIs as fallback).
 *
 *  WIF/ETH  : Uniswap v4 StateView.getSlot0(poolId) on Robinhood Chain (pool 0x71ef…8c79, currency0 = native ETH, currency1 = WIF)
 *  ETH/USD  : Chainlink ETH / USD proxy on Robinhood Chain (from Chainlink's reference directory for robinhood-mainnet)
 *             → Coinbase public spot API if the feed is stale/unreachable
 *  fallback : DexScreener pair API (priceUsd / priceNative) if the onchain read fails
 *
 * Cached ~12s in the shared store (Redis when set), so N replicas share one upstream read per window.
 * Served at GET /api/price and pushed over SSE at GET /api/price/stream.
 * Swap quotes: GET /api/swap/quote (v4 Quoter via eth_call, KyberSwap aggregator API as a quote-only fallback).
 */
import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { formatUnits, parseAbi, parseUnits, type Address, type Hex } from 'viem'
import type { Env } from './auth'
import { rpcCached, store } from './cache'
import { envInt, Lru } from './lru'
import { wiflyContract } from './config'
import { chainClient } from './chain'
import { fail, rateLimit } from './util'
import { clientIp } from './abuse'

export const UNI = {
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' as Address,   // Uniswap deployments/4663.md, code checked on chain
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as Address,
  poolId: '0x71ef4106340f0a3b9c19ec994eef4fc44a1d2513f38faac39d7636b156548c79' as Hex,
  poolKey: {
    currency0: '0x0000000000000000000000000000000000000000' as Address,
    currency1: '0x5173b8eA6923c2d40267890D45C46a3480954773' as Address,
    fee: 0, tickSpacing: 200, hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' as Address,
  },
}
export const CHAINLINK_ETH_USD = (process.env.CHAINLINK_ETH_USD || '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9') as Address
const DEXSCREENER = `https://api.dexscreener.com/latest/dex/pairs/robinhood/${UNI.poolId}`
export const priceTtl = () => Math.max(1_000, Number(process.env.PRICE_TTL_MS || 12_000))
export const quoteTtl = () => Math.max(1_000, Number(process.env.QUOTE_TTL_MS || 20_000))
/** Per-IP cap on price and quote HTTP reads (window 60s). */
export const pricePerIp = () => Math.max(1, Number(process.env.PRICE_PER_IP_MIN || 120))
const KEY = 'price:wif:v1'
const KYBER_WAIT_MS = 250
/** Without Redis, quotes get their own bounded LRU so a flood of distinct amounts can't push feed entries out of the shared store. Keep last-good well past the fresh TTL. */
const quoteKeep = () => Math.max(quoteTtl() * 50, 10 * 60_000)
const quoteMem = new Lru<string, string>({ max: envInt('QUOTE_MAX_ENTRIES', 1000), ttlMs: quoteKeep() })
const CH = 'price:wif'

export type WifPrice = {
  usd: number; eth: number; wifPerEth: number; ethUsd: number
  source: { wif: 'uniswap-v4' | 'dexscreener'; ethUsd: 'chainlink' | 'coinbase' | 'dexscreener' }
  updatedAt: number; stale: boolean; poolId: string
}

const SLOT0 = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'])
const FEED = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)'])
const QUOTER = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
])

async function timed<T>(p: Promise<T>, ms = 4000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
}
async function wifPerEthOnchain() {
  const [sqrtP] = await timed(chainClient().readContract({ address: UNI.stateView, abi: SLOT0, functionName: 'getSlot0', args: [UNI.poolId] }))
  const r = Number(sqrtP) / 2 ** 96
  const p = r * r // both tokens have 18 decimals → WIF per ETH
  if (!(p > 0)) throw new Error('empty pool')
  return p
}
async function ethUsdChainlink() {
  const [, answer, , updatedAt] = await timed(chainClient().readContract({ address: CHAINLINK_ETH_USD, abi: FEED, functionName: 'latestRoundData' }))
  // Heartbeat is 24h with 0.5% deviation; treat >26h as stale.
  if (Date.now() / 1000 - Number(updatedAt) > 26 * 3600) throw new Error('stale feed')
  return Number(answer) / 1e8
}
async function ethUsdCoinbase() {
  const r = await timed(fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot').then(r => r.json() as Promise<{ data: { amount: string } }>))
  return Number(r.data.amount)
}
async function dexscreener() {
  const r = await timed(fetch(DEXSCREENER).then(r => r.json() as Promise<{ pairs?: { priceUsd: string; priceNative: string }[] }>))
  const p = r.pairs?.[0]
  if (!p) throw new Error('no pair')
  return { usd: Number(p.priceUsd), eth: Number(p.priceNative) }
}

/** Fresh read from upstream (no cache). */
export async function fetchPrice(): Promise<WifPrice> {
  let wifPerEth: number | null = null, ethUsd: number | null = null
  let src: WifPrice['source'] = { wif: 'uniswap-v4', ethUsd: 'chainlink' }
  const [a, b] = await Promise.allSettled([wifPerEthOnchain(), ethUsdChainlink()])
  if (a.status === 'fulfilled') wifPerEth = a.value
  if (b.status === 'fulfilled') ethUsd = b.value
  else { try { ethUsd = await ethUsdCoinbase(); src.ethUsd = 'coinbase' } catch { /* below */ } }
  if (wifPerEth === null || ethUsd === null) {
    const d = await dexscreener()
    if (wifPerEth === null) { wifPerEth = 1 / d.eth; src = { ...src, wif: 'dexscreener' } }
    if (ethUsd === null) { ethUsd = d.usd / d.eth; src.ethUsd = 'dexscreener' }
  }
  return { usd: ethUsd / wifPerEth, eth: 1 / wifPerEth, wifPerEth, ethUsd, source: src, updatedAt: Date.now(), stale: false, poolId: UNI.poolId }
}

let priceSource: (() => Promise<WifPrice>) | null = null
/** Tests inject a mocked upstream so nothing touches the network. */
export function setPriceSource(fn: (() => Promise<WifPrice>) | null) { priceSource = fn }
export function resetPriceState() { last = null; inflight = null }

let inflight: Promise<WifPrice> | null = null
let last: WifPrice | null = null
/** How long a price may be served while a refresh runs behind it. */
const KEEP = () => Math.max(priceTtl() * 50, 10 * 60_000)
const priceKeep = KEEP
function refreshPrice(): Promise<WifPrice> {
  if (!inflight) inflight = (async () => {
    try {
      const p = await (priceSource ?? fetchPrice)()
      last = p
      await store.set(KEY, JSON.stringify(p), priceKeep()).catch(() => {})
      await store.publish(CH, JSON.stringify(p)).catch(() => {})
      return p
    } catch (e) {
      if (last) return { ...last, stale: Date.now() - last.updatedAt > 60_000 }
      throw e
    } finally { inflight = null }
  })()
  return inflight
}
/**
 * Cached price, stale-while-revalidate: a fresh value (< TTL) is returned as is; an older one is returned at once
 * and one upstream read runs in the background. Only the very first read of a cold process with an empty shared
 * cache waits on the chain, and warmPrice() at boot takes that hit before any visitor does.
 */
export async function getPrice(): Promise<WifPrice> {
  const hit = await store.get(KEY).catch(() => null)
  const cur: WifPrice | null = hit ? JSON.parse(hit) : last
  if (cur) {
    last = cur
    const age = Date.now() - cur.updatedAt
    if (age < priceTtl()) return cur
    void refreshPrice().catch(() => {})
    return { ...cur, stale: age > 60_000 }
  }
  return refreshPrice()
}
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as Address
const BURN_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalBurned() view returns (uint256)'])
export type BurnStats = { burnAddressWif: number | null; burnedViaWifly: number | null; live: boolean; at: number }
export function burnStats(): Promise<BurnStats> {
  return rpcCached('burn:v1', 30_000, async () => {
    const W = wiflyContract()
    const c = chainClient()
    const [dead, via] = await Promise.allSettled([
      timed(c.readContract({ address: UNI.poolKey.currency1, abi: BURN_ABI, functionName: 'balanceOf', args: [BURN_ADDRESS] })),
      W ? timed(c.readContract({ address: W as Address, abi: BURN_ABI, functionName: 'totalBurned' })) : Promise.reject(new Error('not live')),
    ])
    if (dead.status === 'rejected' && (!W || via.status === 'rejected')) throw new Error('burn reads failed') // keep the last good value
    return {
      burnAddressWif: dead.status === 'fulfilled' ? Number(formatUnits(dead.value, 18)) : null,
      burnedViaWifly: via.status === 'fulfilled' ? Number(formatUnits(via.value, 18)) : null,
      live: !!W, at: Date.now(),
    }
  }).catch(() => ({ burnAddressWif: null, burnedViaWifly: null, live: !!wiflyContract(), at: Date.now() }))
}
export function warmPrice() {
  void burnStats()
  void refreshPrice().catch(() => {})
}

// ------------------------------------------------------------------ quotes

export type SwapDir = 'eth2wif' | 'wif2eth'
export async function quote(dir: SwapDir, amountIn: bigint) {
  const zeroForOne = dir === 'eth2wif'
  const price = await getPrice().catch(() => null)
  let amountOut: bigint, gas = 0n, source: 'uniswap-v4' | 'kyberswap' = 'uniswap-v4'
  // Kyber is asked in parallel, quote only (its UI is never shown). It's used when the direct quote fails, and
  // reported as `alt` when it beats the direct pool by more than 0.3%. The app always executes the direct route.
  const kyber = kyberQuote(zeroForOne, amountIn).catch(() => null)
  try {
    const { result } = await timed(chainClient().simulateContract({
      address: UNI.v4Quoter, abi: QUOTER, functionName: 'quoteExactInputSingle',
      args: [{ poolKey: UNI.poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
    }), 5000)
    ;[amountOut, gas] = result
  } catch {
    const k = await kyber
    if (k === null) fail(502, 'no quote right now')
    amountOut = k!; source = 'kyberswap'
  }
  // the direct quote is what executes; Kyber only gets ~250ms more to show up as a comparison
  const k = source === 'uniswap-v4' ? await Promise.race([kyber, new Promise<null>(r => setTimeout(() => r(null), KYBER_WAIT_MS))]) : null
  const alt = k !== null && k * 1000n > amountOut * 1003n
    ? { source: 'kyberswap' as const, amountOut: k.toString(), betterBy: Number(k - amountOut) / Number(amountOut) }
    : null
  const inN = Number(formatUnits(amountIn, 18)), outN = Number(formatUnits(amountOut, 18))
  const mid = price ? (zeroForOne ? price.wifPerEth : 1 / price.wifPerEth) : null
  const impact = mid ? Math.max(0, 1 - (outN / inN) / mid) : null
  return {
    dir, amountIn: amountIn.toString(), amountOut: amountOut.toString(), gasEstimate: gas.toString(), source,
    priceImpact: impact, rate: outN / inN,
    usdIn: price ? (zeroForOne ? inN * price.ethUsd : inN * price.usd) : null,
    usdOut: price ? (zeroForOne ? outN * price.usd : outN * price.ethUsd) : null,
    poolKey: UNI.poolKey, poolFeeBps: 100, alt, at: Date.now(),
  }
}

async function kyberQuote(zeroForOne: boolean, amountIn: bigint): Promise<bigint | null> {
  const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
  const [i, o] = zeroForOne ? [ETH, UNI.poolKey.currency1] : [UNI.poolKey.currency1, ETH]
  const r = await timed(fetch(`https://aggregator-api.kyberswap.com/robinhood/api/v1/routes?tokenIn=${i}&tokenOut=${o}&amountIn=${amountIn}`, { headers: { 'x-client-id': 'wifly' } })
    .then(r => r.json() as Promise<{ data?: { routeSummary?: { amountOut: string } } }>), 4000)
  return r.data?.routeSummary ? BigInt(r.data.routeSummary.amountOut) : null
}


let quoteSource: ((dir: SwapDir, amountIn: bigint) => Promise<Awaited<ReturnType<typeof quote>>>) | null = null
/** Tests inject a mocked quoter. */
export function setQuoteSource(fn: typeof quoteSource) { quoteSource = fn }
const quoteInflight = new Map<string, Promise<Awaited<ReturnType<typeof quote>>>>()

async function readQuoteCache(key: string): Promise<(Awaited<ReturnType<typeof quote>>) | null> {
  const raw = store.kind === 'memory' ? (quoteMem.get(key) ?? null) : await store.get(key).catch(() => null)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}
async function writeQuoteCache(key: string, q: Awaited<ReturnType<typeof quote>>) {
  const raw = JSON.stringify(q)
  if (store.kind === 'memory') quoteMem.set(key, raw)
  else await store.set(key, raw, quoteKeep()).catch(() => {})
}
function refreshQuote(key: string, dir: SwapDir, amountIn: bigint) {
  let p = quoteInflight.get(key)
  if (!p) {
    p = (async () => {
      try {
        const q = await (quoteSource ?? quote)(dir, amountIn)
        await writeQuoteCache(key, q)
        return q
      } catch (e) {
        const prev = await readQuoteCache(key)
        if (prev) return prev
        throw e
      } finally { quoteInflight.delete(key) }
    })()
    quoteInflight.set(key, p)
  }
  return p
}
/** Cached swap quote, stale-while-revalidate + single-flight. Last good value is served if upstream fails. */
export async function getQuote(dir: SwapDir, amountIn: bigint) {
  const key = `q:${dir}:${amountIn}`
  const cur = await readQuoteCache(key)
  if (cur) {
    const age = Date.now() - (cur.at ?? 0)
    if (age < quoteTtl()) return cur
    void refreshQuote(key, dir, amountIn).catch(() => {})
    return cur
  }
  return refreshQuote(key, dir, amountIn)
}

export function registerPrice(app: Hono<Env>) {
  app.get('/api/price', async c => {
    await rateLimit(`price:${clientIp(c)}`, pricePerIp(), 60_000)
    const p = await getPrice().catch(() => null)
    if (!p) return c.json({ error: 'price unavailable' }, 503)
    c.header('Cache-Control', 'public, max-age=5, stale-while-revalidate=30')
    return c.json(p)
  })
  // Server-sent events: one push per new price. Each replica reads the shared cache on a timer; the
  // Redis pub/sub channel makes a fresh read on any replica reach every replica's clients at once.
  app.get('/api/price/stream', async c => {
    await rateLimit(`price:${clientIp(c)}`, pricePerIp(), 60_000)
    return streamSSE(c, async s => {
    let lastAt = 0, alive = true
    const send = async (p: WifPrice) => { if (p.updatedAt === lastAt) return; lastAt = p.updatedAt; await s.writeSSE({ event: 'price', data: JSON.stringify(p) }) }
    const off = store.subscribe(CH, m => { void send(JSON.parse(m)).catch(() => {}) })
    s.onAbort(() => { alive = false; off() })
    try { await send(await getPrice()) } catch { /* client keeps last */ }
    while (alive) {
      await s.sleep(priceTtl())
      if (!alive) break
      try { await send(await getPrice()) } catch { /* retry next tick */ }
      await s.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => { alive = false })
    }
  })
  })
  // The burn counters on the landing page and the world strip: two chain reads, cached for everyone (SWR), so
  // browsers never make their own RPC calls for them and a slow RPC never holds the page.
  app.get('/api/burn', async c => {
    await rateLimit(`price:${clientIp(c)}`, pricePerIp(), 60_000)
    c.header('Cache-Control', 'public, max-age=15, stale-while-revalidate=60')
    return c.json(await burnStats())
  })
  app.get('/api/swap/quote', async c => {
    await rateLimit(`price:${clientIp(c)}`, pricePerIp(), 60_000)
    const dir = c.req.query('dir') === 'wif2eth' ? 'wif2eth' : 'eth2wif'
    const raw = c.req.query('amount') ?? ''
    if (!/^\d+(\.\d{1,18})?$/.test(raw)) fail(400, 'enter an amount')
    const amt = parseUnits(raw, 18)
    if (amt <= 0n || amt > parseUnits(dir === 'eth2wif' ? '1000' : '10000000000', 18)) fail(400, 'that amount is out of range')
    const q = await getQuote(dir, amt)
    return c.json(q)
  })
}
