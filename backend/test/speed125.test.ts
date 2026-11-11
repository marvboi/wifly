/** speed.12.5: RPC fallback, price/quote SWR + single-flight, last-good, per-IP rate limit. All upstreams mocked. */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, custom, fallback, defineChain, parseAbi } from 'viem'
import { chainClient, setChainTransport } from '../src/chain'
import { Hono } from 'hono'
import { dedupeTransport, fallbackRpc, parseRpcList, rpcUrls, DEFAULT_RPC_URLS, OFFICIAL_RPC } from '../src/rpc'
import { store } from '../src/cache'
import { resetRateLimits } from '../src/util'
import {
  getPrice, getQuote, setPriceSource, setQuoteSource, resetPriceState, registerPrice,
  priceTtl, pricePerIp, type WifPrice,
} from '../src/price'
import { rpcUrls as feRpcUrls, parseRpcList as feParse, DEFAULT_RPC_URLS as FE_DEFAULTS } from '../../frontend/src/lib/rpc'

const root = join(import.meta.dirname, '../..')
const src = (r: string) => readFileSync(join(root, 'frontend/src', r), 'utf8')
const be = (r: string) => readFileSync(join(root, 'backend/src', r), 'utf8')

const sample = (over: Partial<WifPrice> = {}): WifPrice => ({
  usd: 0.024, eth: 0.000008, wifPerEth: 125_000, ethUsd: 3000,
  source: { wif: 'uniswap-v4', ethUsd: 'chainlink' },
  updatedAt: Date.now(), stale: false, poolId: '0x71ef',
  ...over,
})

const quoteOk = (amountIn: bigint): Awaited<ReturnType<typeof getQuote>> => ({
  dir: 'eth2wif' as const, amountIn: amountIn.toString(), amountOut: (amountIn * 100n).toString(),
  gasEstimate: '1', source: 'uniswap-v4' as const, priceImpact: 0, rate: 100,
  usdIn: 3, usdOut: 3, poolKey: { currency0: '0x0000000000000000000000000000000000000000', currency1: '0x0000000000000000000000000000000000000001', fee: 100, tickSpacing: 1, hooks: '0x0000000000000000000000000000000000000000' }, poolFeeBps: 100, alt: null, at: Date.now(),
})

afterEach(() => {
  setPriceSource(null)
  setQuoteSource(null)
  resetPriceState()
  resetRateLimits()
})

test('package version is 0.12.6.13', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
})

test('rpc list: official + public defaults, env overrides come first, no keyed URLs', () => {
  assert.equal(OFFICIAL_RPC, 'https://rpc.mainnet.chain.robinhood.com')
  assert.deepEqual([...DEFAULT_RPC_URLS], [...FE_DEFAULTS])
  assert.ok(DEFAULT_RPC_URLS.includes(OFFICIAL_RPC))
  const def = rpcUrls({})
  assert.equal(def[0], OFFICIAL_RPC)
  assert.ok(def.includes('https://robinhood.drpc.org'))
  assert.ok(def.includes('https://robinhood-rpc.publicnode.com'))
  const over = rpcUrls({ RPC_URL: 'https://example.rpc.test', RPC_URLS: 'https://alt.rpc.test, https://robinhood.drpc.org' })
  assert.equal(over[0], 'https://example.rpc.test')
  assert.equal(over[1], 'https://alt.rpc.test')
  assert.ok(over.includes(OFFICIAL_RPC))
  assert.equal(new Set(over).size, over.length, 'deduped')
  assert.deepEqual(parseRpcList('https://a.com', 'https://a.com/, https://b.com'), ['https://a.com', 'https://b.com'])
  const fe = feRpcUrls({ VITE_RPC_URL: 'https://fe.rpc.test' })
  assert.equal(fe[0], 'https://fe.rpc.test')
  assert.ok(fe.includes(OFFICIAL_RPC))
  for (const u of [...def, ...over, ...fe]) {
    assert.doesNotMatch(u, /alchemy|quicknode|chainstack|API_KEY|\/v2\/[A-Za-z0-9]/i)
  }
})

test('one provider down: the fallback transport retries on the next RPC', async () => {
  let a = 0, b = 0
  const down = custom({ request: async () => { a++; throw new Error('provider down') } })
  const up = custom({ request: async ({ method }) => { b++; if (method === 'eth_chainId') return '0x1237'; return '0x1' } })
  const client = createPublicClient({ transport: fallback([down, up]) })
  const id = await client.request({ method: 'eth_chainId' })
  assert.equal(id, '0x1237')
  assert.ok(a >= 1, 'first provider was tried')
  assert.ok(b >= 1, 'fallback provider answered')
})

test('identical in-flight reads are deduped', async () => {
  let n = 0
  let release!: (v: unknown) => void
  const gate = new Promise(r => { release = r })
  const slow = custom({
    request: async ({ method }) => {
      n++
      await gate
      return method === 'eth_blockNumber' ? '0x10' : '0x1'
    },
  })
  const client = createPublicClient({ transport: dedupeTransport(slow) })
  const p = Promise.all([
    client.request({ method: 'eth_blockNumber' }),
    client.request({ method: 'eth_blockNumber' }),
    client.request({ method: 'eth_blockNumber' }),
  ])
  await new Promise(r => setTimeout(r, 10))
  assert.equal(n, 1, 'one upstream call while the first is in flight')
  release(null)
  const out = await p
  assert.deepEqual(out, ['0x10', '0x10', '0x10'])
})

test('all providers down with a cached price: last good value is served (possibly stale)', async () => {
  let calls = 0
  setPriceSource(async () => { calls++; return sample({ updatedAt: Date.now() }) })
  const first = await getPrice()
  assert.equal(first.usd, 0.024)
  assert.equal(calls, 1)
  setPriceSource(async () => { calls++; throw new Error('all rpcs down') })
  // still fresh: no new upstream
  const fresh = await getPrice()
  assert.equal(fresh.usd, 0.024)
  assert.equal(calls, 1)
  // expire freshness
  resetPriceState()
  // put an old value into the shared store (last-good)
  const old = sample({ updatedAt: Date.now() - 120_000, stale: false })
  await store.set('price:wif:v1', JSON.stringify(old), 10 * 60_000)
  const served = await getPrice()
  assert.equal(served.usd, 0.024)
  assert.equal(served.stale, true)
  await new Promise(r => setTimeout(r, 20))
  assert.ok(calls >= 2, 'a background refresh was attempted')
})

test('stampede protection: concurrent getPrice shares one upstream fetch', async () => {
  resetPriceState()
  resetRateLimits()
  let calls = 0
  setPriceSource(async () => {
    calls++
    await new Promise(r => setTimeout(r, 40))
    return sample({ updatedAt: Date.now() })
  })
  const got = await Promise.all(Array.from({ length: 80 }, () => getPrice()))
  assert.equal(calls, 1)
  assert.ok(got.every(p => p.usd === 0.024))
})

test('quote cache: last good value is served when the quoter fails', async () => {
  const prev = process.env.QUOTE_TTL_MS
  process.env.QUOTE_TTL_MS = '40'
  let calls = 0
  const amt = 10n ** 18n
  setQuoteSource(async (_d, a) => { calls++; return quoteOk(a) })
  const a = await getQuote('eth2wif', amt)
  assert.equal(a.amountOut, (amt * 100n).toString())
  assert.equal(calls, 1)
  setQuoteSource(async () => { calls++; throw new Error('quoter down') })
  await new Promise(r => setTimeout(r, 50))
  const b = await getQuote('eth2wif', amt)
  assert.equal(b.amountOut, a.amountOut)
  await new Promise(r => setTimeout(r, 20))
  if (prev === undefined) delete process.env.QUOTE_TTL_MS
  else process.env.QUOTE_TTL_MS = prev
})

test('per-IP rate limit on /api/price and /api/swap/quote', async () => {
  const prev = process.env.PRICE_PER_IP_MIN
  process.env.PRICE_PER_IP_MIN = '5'
  try {
    assert.equal(pricePerIp(), 5)
    setPriceSource(async () => sample({ updatedAt: Date.now() }))
    setQuoteSource(async (_d, a) => quoteOk(a))
    await getPrice()
    const app = new Hono()
    app.onError((err, c) => {
      const status = (err as unknown as { status?: number }).status
      return c.json({ error: (err as Error).message }, (typeof status === 'number' ? status : 500) as never)
    })
    registerPrice(app as never)
    const hit = (path: string, ip: string) => app.request(path, { headers: { 'x-forwarded-for': ip } })
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await hit('/api/price', '203.0.113.50')).status)
    assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200])
    assert.equal(codes[5], 429)
    const body = await (await hit('/api/price', '203.0.113.50')).json()
    assert.equal(body.error, 'slow down a little')
    const qcodes: number[] = []
    for (let i = 0; i < 6; i++) qcodes.push((await hit('/api/swap/quote?dir=eth2wif&amount=1', '203.0.113.51')).status)
    assert.deepEqual(qcodes.slice(0, 5), [200, 200, 200, 200, 200])
    assert.equal(qcodes[5], 429)
  } finally {
    if (prev === undefined) delete process.env.PRICE_PER_IP_MIN
    else process.env.PRICE_PER_IP_MIN = prev
  }
})

test('frontend shows last known rate quietly and uses a fallback transport', () => {
  const price = src('lib/price.tsx')
  assert.match(price, /last-known rate stays on screen/)
  assert.match(price, /usd--quiet/)
  assert.doesNotMatch(price, /value === undefined \|\| stale/)
  assert.match(src('wagmi.ts'), /fallbackRpc/)
  assert.match(src('wagmi.ts'), /multicall/)
  assert.match(src('lib/rpc.ts'), /VITE_RPC_URL/)
  assert.match(src('lib/rpc.ts'), /dedupeTransport/)
  assert.match(src('components/Swap.tsx'), /placeholderData/)
  assert.match(be('chain.ts'), /fallbackRpc/)
  assert.match(be('rpc.ts'), /timeout: HTTP_TIMEOUT_MS/)
  assert.match(be('rpc.ts'), /RPC_URLS/)
  assert.match(be('price.ts'), /pricePerIp/)
  assert.match(be('price.ts'), /getQuote/)
  assert.match(src('pages/Profile.tsx'), /MetaItem icon="calendar"/)
  assert.match(src('pages/Profile.tsx'), /MetaItem icon="mapPin"/)
  assert.match(src('components/PostCard.tsx'), /MetaItem icon="clock"/)
  assert.match(src('components/PostCard.tsx'), /MetaItem icon="calendar"/)
  assert.match(src('styles/app.css'), /\.meta-ico/)
  assert.match(src('styles/app.css'), /infotip__pop--float\.infotip__pop--top/)
  assert.match(src('styles/app.css'), /bottom:\s*auto/)
  assert.match(src('components/InfoTip.tsx'), /requestAnimationFrame/)
  assert.match(src('components/InfoTip.tsx'), /getBoundingClientRect/)
})


import { tipPayoutTarget, tipPayoutMismatch } from '../../frontend/src/lib/tipPayout'

test('tip destination falls back to the first wallet when payout is missing and never throws', () => {
  const wallet = { address: '0xabc0000000000000000000000000000000000001' }
  assert.equal(tipPayoutTarget({ payout: null, wallets: [wallet] }), wallet.address)
  assert.equal(tipPayoutTarget({ payout: { address: null }, wallets: [wallet] }), wallet.address)
  assert.equal(tipPayoutTarget({ payout: { address: '  ' }, wallets: [wallet] }), wallet.address)
  assert.equal(tipPayoutTarget({ payout: { address: '0xpay' }, wallets: [wallet] }), '0xpay')
  assert.equal(tipPayoutTarget(null), null)
  assert.equal(tipPayoutTarget({}), null)
  assert.equal(tipPayoutTarget({ payout: null, wallets: undefined }), null)
  assert.doesNotThrow(() => tipPayoutTarget({ payout: null, wallets: null }))
  assert.equal(tipPayoutMismatch({ payout: null }, null), false)
  assert.equal(tipPayoutMismatch({ payout: { name: 'kai', resolves: '0xaaa', address: '0xbbb' } }, '0xbbb'), true)
  assert.match(src('components/WalletProofs.tsx'), /tipPayoutTarget/)
  assert.match(src('components/WalletProofs.tsx'), /payout\?\.address/)
})

test('cache stays optional: memory when REDIS_URL is unset; boot logs which cache is in use', () => {
  assert.equal(store.kind, process.env.REDIS_URL ? 'redis' : 'memory')
  assert.doesNotMatch(be('cache.ts'), /throw.*REDIS_URL|REDIS_URL is required/)
  assert.doesNotMatch(be('server.ts'), /if \(!process\.env\.REDIS_URL\)/)
  assert.match(be('server.ts'), /\[cache\] using \$\{store\.kind\}/)
  assert.match(be('cache.ts'), /process\.env\.REDIS_URL \? redis\(process\.env\.REDIS_URL\) : memory\(\)/)
})

test('settings extras, one sign-in control, dock clearance, dark muted contrast', () => {
  const settings = src('pages/Settings.tsx')
  assert.match(settings, /data-testid="settings-about"/)
  assert.doesNotMatch(settings, /data-testid="settings-notifications"/)
  assert.doesNotMatch(settings, /<h2 className="sc-section__h">notifications<\/h2>/)
  assert.match(settings, />version<\/span><span className="muted">0\.12\.6\.13</)
  assert.match(settings, />docs<\/AppLink>/)
  assert.match(settings, /\$wif on x/)
  assert.match(settings, /sign in to manage your settings\./)
  const shell = src('components/Shell.tsx')
  assert.doesNotMatch(shell, /openSheet\(\{ type: 'signin', reason: PRIVATE/)
  assert.match(shell, /the sign-in sheet never auto-opens on load/)
  // one primary join-bar sign-in; "join wifly" is no longer a second button
  assert.equal([...shell.matchAll(/<button className="joinbar__btn/g)].length, 1)
  assert.match(shell, />sign in<\/button>/)
  assert.doesNotMatch(shell, /joinbar__btn--ghost/)
  assert.match(src('pages/settings/ConceptB.tsx'), /data-testid="settings-wallets-tips"/)
  assert.match(src('pages/settings/ConceptB.tsx'), /sc-group/)
  assert.match(src('styles/app.css'), /--dock-clearance/)
  assert.match(src('styles/app.css'), /env\(safe-area-inset-bottom/)
  assert.match(src('styles/settings-concepts.css'), /--dock-clearance/)
  assert.match(src('styles/dark.css'), /--muted:\s*#C4BFB4/)
  // --muted is raised only in dark.css, not theme.css
  const theme = src('styles/theme.css')
  assert.doesNotMatch(theme, /--muted:\s*#C4BFB4/)
})

test('setChainTransport mocks receive raw eth_call, not Multicall3 batches', async () => {
  const seen: string[] = []
  const target = '0x5173b8ea6923c2d40267890d45c46a3480954773'
  setChainTransport(custom({ async request({ method, params }: any) {
    if (method === 'eth_chainId') return '0x1237'
    if (method === 'eth_call') {
      seen.push(String(params[0].to).toLowerCase())
      return '0x0000000000000000000000000000000000000000000000000000000000000001'
    }
    throw new Error(`unexpected ${method}`)
  } }))
  try {
    const v = await chainClient().readContract({
      address: target as `0x${string}`,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: ['0x0000000000000000000000000000000000000001'],
    })
    assert.equal(v, 1n)
    assert.equal(seen.length, 1)
    assert.equal(seen[0], target)
    assert.equal(seen[0], target) // not Multicall3
    assert.notEqual(seen[0], '0xcA11bde05977b3631167028862bE2a173976CA11'.toLowerCase())
    assert.match(be('chain.ts'), /batch: override \? undefined : \{ multicall: true \}/)
  } finally {
    setChainTransport(null)
  }
})
