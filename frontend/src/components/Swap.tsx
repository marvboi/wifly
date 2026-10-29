/**
 * "get $WIF": our own swap modal. Routing is lib/wifSwap.ts, exact-in) plus lib/wifSwapOut.ts (exact-out
 * for "get WIF for …" shortcuts). One pool: Uniswap v4 ETH/WIF on Robinhood Chain, executed through the Universal Router
 * 0x8876…0904. The pool hook takes a 1% fee, already inside every quote.
 *
 * Flow: live Quoter quote (re-quoted every 10s with a countdown) → review → simulate (eth_call) → wallet → receipt →
 * then the coin animation. Sells show three steps: exact-amount WIF approve to Permit2 (never unlimited), a 30-minute
 * Permit2 allowance to the router, then the swap. Buys are a single step. TX_ENABLED=false stops before the wallet.
 */
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { encodeFunctionData, formatEther, formatUnits, parseAbi, parseEther, parseUnits, type Address, type Hex } from 'viem'
import { useBalance, usePublicClient, useWalletClient } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DEXSCREENER, robinhoodChain, SWAP_POOL_FEE_BPS, TX_ENABLED, WIF_DECIMALS, WIF_TOKEN } from '../config'
import { useWifBalance } from '../lib/chain'
import { useWifPrice, Usd } from '../lib/price'
import { ADDR, buildSwap, GAS_TOPUP_WEI, minOut, POOL_ID, quote, type Side, type SwapOpts } from '../lib/wifSwap'
import { buildBuyExactOut, maxIn, quoteBuyExactOut, withBuffer } from '../lib/wifSwapOut'
import { explainError, notConnectedReason, usePayerRoute } from '../lib/wifly'
import { privyBridge, useAnyAccount } from '../auth/privyBridge'
import { CopyAddr, PayingFrom, usePayerBalances } from './Payer'
import { canTopUp, receiveChoices, shortA, swapRecipient, topUpDefault, topUpNote, TOPUP_LABEL } from '../lib/payer'
import { usePayerState } from '../lib/payerStore'
import { GasWallet } from './TxNote'
import { GAS_LINE, shortOnGas } from '../lib/txError'
import { useStore } from '../state/store'
import { CoinRain } from './CoinRain'
import { CopyAddress, Token } from './Bits'
import { Icon } from './Icon'
import { Tick } from './Delight'

const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const fmtEth = (n: number) => (n === 0 ? '0' : n < 0.0001 ? n.toPrecision(2) : fmt(n, n < 1 ? 5 : 4))
const REQUOTE_MS = 10_000
const GAS_RESERVE = 0.0003 // ETH kept back on "max" for gas
const SLIPPAGES = [50, 100, 300] as const // bps

const erc20 = parseAbi(['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'])
const permit2 = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])

export type SwapPreset = { wifOut?: number; reason?: string }
type StepState = 'todo' | 'active' | 'done' | 'skip'
type Phase = 'edit' | 'review' | 'sending' | 'done'

/** Seconds since a timestamp, ticking once a second. */
function useAgo(at: number | undefined) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  return at ? Math.max(0, Math.floor((now - at) / 1000)) : undefined
}


export function SwapPanel({ compact = false, preset, onDone }: { compact?: boolean; preset?: SwapPreset; onDone?: () => void }) {
  const { toast } = useStore()
  const qc = useQueryClient()
  // 11.8.5: the wallet picked in the wallet menu pays here too (wagmi or privy, embedded or linked)
  const { address, picked, route, viaPrivy } = usePayerRoute()
  const isConnected = !!address
  const pub = usePublicClient({ chainId: robinhoodChain.id })
  const { data: wallet } = useWalletClient({ chainId: robinhoodChain.id })
  const canSend = picked ? route !== 'none' : viaPrivy || !!wallet
  /** one raw send from the paying wallet */
  const sendFromPayer = async (to: Address, data: Hex, value?: bigint): Promise<Hex> => {
    if (viaPrivy) return picked ? privyBridge.sendFrom(picked.address, to, data, robinhoodChain.id, value) : privyBridge.sendTx(to, data, robinhoodChain.id, value)
    if (!wallet || !address) throw new Error('connect a wallet first')
    return wallet.sendTransaction({ account: address as Address, chain: wallet.chain, to, data, value })
  }
  const ethBal = useBalance({ address, chainId: robinhoodChain.id, query: { enabled: !!address } })
  const eth = ethBal.data ? Number(formatEther(ethBal.data.value)) : undefined
  const wifBal = useWifBalance(address).value
  const { price, stale } = useWifPrice()

  const exactOut = !!preset?.wifOut
  const [side, setSide] = useState<Side>('buy')
  const [input, setInput] = useState(exactOut ? String(preset!.wifOut) : '0.001')
  const [slip, setSlip] = useState<number>(100)
  const [detailsOpen, setDetailsOpen] = useState(false) // lives here so the once-a-second tick can't close it
  const [custom, setCustom] = useState('')
  const [phase, setPhase] = useState<Phase>('edit')
  const [steps, setSteps] = useState<StepState[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [hash, setHash] = useState<Hex | null>(null)
  const [rain, setRain] = useState(false)

  // 11.8.5: "receive in" (router recipient, fork-tested) + "top up gas too" (UR TRANSFER of 0.0001 eth in the same tx)
  const payerState = usePayerState()
  const choice = receiveChoices(address ?? null, payerState.options)
  const [receivePick, setReceivePick] = useState<string | null>(null)
  const receiveIn = choice ? (receivePick && [choice.embedded, choice.linked].includes(receivePick) ? receivePick : choice.embedded) : null
  const embBal = usePayerBalances(choice ? [choice.embedded] : [])
  const embEth = choice ? embBal.data?.[choice.embedded]?.eth : undefined
  const topUpOk = canTopUp(side, address ?? null, receiveIn, choice?.embedded ?? null)
  const [topUpPick, setTopUpPick] = useState<boolean | null>(null)
  const topUp = topUpOk && (topUpPick ?? topUpDefault(embEth, receiveIn === choice?.embedded))
  const recipient = swapRecipient(address ?? null, receiveIn) as Address | undefined
  const swapOpts: SwapOpts = { recipient, gasTopUp: topUp && choice ? { to: choice.embedded as Address, wei: GAS_TOPUP_WEI } : undefined }

  const amount = Number(input) || 0
  const amt = useDebounce(amount, 300)
  const units = useMemo(() => {
    try {
      if (amt <= 0) return 0n
      if (exactOut || side === 'sell') return parseUnits(String(amt), WIF_DECIMALS)
      return parseEther(String(amt))
    } catch { return 0n }
  }, [amt, side, exactOut])

  // Direct pool quote via the v4 Quoter (eth_call). Exact-out for shortcuts, exact-in otherwise.
  const q = useQuery({
    queryKey: ['swapq', side, exactOut, units.toString()],
    enabled: !!pub && units > 0n && phase !== 'sending' && phase !== 'done',
    refetchInterval: REQUOTE_MS,
    queryFn: async () => {
      if (exactOut) { const r = await quoteBuyExactOut(pub!, units); return { inWei: r.amountIn, outWei: units } }
      const r = await quote(pub!, side, units)
      return { inWei: units, outWei: r.amountOut }
    },
  })
  const ago = useAgo(q.dataUpdatedAt || undefined)

  // Backend quote: the same pool plus a KyberSwap comparison. Only surfaced when it beats direct (`alt`) or direct fails.
  const kq = useQuery({
    queryKey: ['swapq-backend', side, units.toString()],
    enabled: !exactOut && units > 0n,
    refetchInterval: REQUOTE_MS * 3,
    queryFn: async () => {
      const r = await fetch(`/api/swap/quote?dir=${side === 'buy' ? 'eth2wif' : 'wif2eth'}&amount=${amt}`)
      if (!r.ok) throw new Error('no backend quote')
      return r.json() as Promise<{ amountOut: string; source: string; alt: boolean; priceImpact: number }>
    },
  })

  const inDec = side === 'buy' ? 18 : WIF_DECIMALS
  const outDec = side === 'buy' ? WIF_DECIMALS : 18
  const inN = q.data ? Number(formatUnits(q.data.inWei, inDec)) : (exactOut ? undefined : amount)
  const outN = q.data ? Number(formatUnits(q.data.outWei, outDec)) : (exactOut ? amount : undefined)
  const slipBps = BigInt(slip)
  const limitOut = q.data && !exactOut ? Number(formatUnits(minOut(q.data.outWei, slipBps), outDec)) : undefined
  const limitIn = q.data && exactOut ? Number(formatEther(maxIn(q.data.inWei, slipBps))) : undefined

  // Price impact vs the pool's spot price (from the backend price service), excluding the fixed 1% hook fee.
  const impact = useMemo(() => {
    if (!price || !inN || !outN) return undefined
    const spot = side === 'buy' ? price.wifPerEth : 1 / price.wifPerEth
    return Math.max(0, 1 - (outN / inN) / (spot * 0.99))
  }, [price, inN, outN, side])

  const usdIn = price && inN ? inN * (side === 'buy' ? price.ethUsd : price.usd) : undefined
  const usdOut = price && outN ? outN * (side === 'buy' ? price.usd : price.ethUsd) : undefined
  const balIn = side === 'buy' ? eth : wifBal
  const balOut = side === 'buy' ? wifBal : eth
  const needIn = exactOut ? limitIn : inN
  const tooMuch = isConnected && balIn !== undefined && needIn !== undefined && needIn > balIn
  const highSlip = slip > 300

  const setMax = () => {
    if (balIn === undefined) return
    setInput(side === 'buy' ? String(Math.max(0, +(balIn - GAS_RESERVE).toFixed(6))) : String(Math.floor(balIn)))
  }
  const flip = () => { if (exactOut) return; setSide(s => (s === 'buy' ? 'sell' : 'buy')); setInput(outN ? String(+outN.toPrecision(6)) : ''); setPhase('edit') }

  const stepLabels = side === 'sell'
    ? [`allow ${fmt(amount, 2)} wif`, 'allow the swap for 30 minutes', 'swap']
    : ['swap']

  const execute = async () => {
    setErr(null)
    if (!q.data || !pub) return
    const n = stepLabels.length
    setSteps(Array(n).fill('todo'))
    setPhase('sending')
    try {
      const owner = address as Address | undefined
      const call = exactOut
        ? buildBuyExactOut(q.data.outWei, maxIn(q.data.inWei, slipBps), owner ?? ADDR.universalRouter, 600, swapOpts)
        : buildSwap(side, q.data.inWei, minOut(q.data.outWei, slipBps), 600, swapOpts)

      // Which sell approvals are already in place (read-only).
      let needErc = side === 'sell', needP2 = side === 'sell'
      if (side === 'sell' && owner) {
        const a = await pub.readContract({ address: WIF_TOKEN, abi: erc20, functionName: 'allowance', args: [owner, ADDR.permit2] })
        const [p2a, p2e] = await pub.readContract({ address: ADDR.permit2, abi: permit2, functionName: 'allowance', args: [owner, WIF_TOKEN, ADDR.universalRouter] })
        needErc = a < q.data.inWei
        needP2 = p2a < q.data.inWei || p2e <= Math.floor(Date.now() / 1000)
      }
      // Simulate before the wallet opens. For a sell that still needs approvals the swap can't be simulated yet; it is
      // simulated again right after the approvals land.
      if (owner && !(needErc || needP2)) await pub.simulateContract({ account: owner, ...call })

      if (owner && picked && route === 'none') { setErr(notConnectedReason(picked)); setPhase('review'); return }
      if (!TX_ENABLED || !owner || !canSend) {
        setPhase('review')
        toast(!owner ? 'connect a wallet first' : 'swaps aren’t switched on yet', !owner ? undefined : 'nothing was sent')
        return
      }
      // 11.8.5: no eth for gas (or for the eth being swapped) = say so up front and don't open the wallet
      const eth = await pub.getBalance({ address: owner }).catch(() => null)
      // call.value = the eth being swapped + any gas top-up
      if (eth !== null && shortOnGas(eth, null, call.value)) { setErr(GAS_LINE); setPhase('review'); return }
      const mark = (i: number, s: StepState) => setSteps(p => p.map((v, j) => (j === i ? s : v)))
      const waitOk = async (h: Hex) => { const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== 'success') throw new Error('reverted on chain') }
      if (side === 'sell') {
        if (needErc) { mark(0, 'active'); await waitOk(await sendFromPayer(WIF_TOKEN, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [ADDR.permit2, q.data.inWei] }))) }
        mark(0, needErc ? 'done' : 'skip')
        if (needP2) { mark(1, 'active'); await waitOk(await sendFromPayer(ADDR.permit2, encodeFunctionData({ abi: permit2, functionName: 'approve', args: [WIF_TOKEN, ADDR.universalRouter, q.data.inWei, Math.floor(Date.now() / 1000) + 30 * 60] }))) }
        mark(1, needP2 ? 'done' : 'skip')
      }
      const last = n - 1
      mark(last, 'active')
      const { request } = await pub.simulateContract({ account: owner, ...call })
      const h = await sendFromPayer(request.address, encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args } as Parameters<typeof encodeFunctionData>[0]), request.value)
      setHash(h)
      await waitOk(h) // confirm-before-animate: coins only fall after the receipt
      mark(last, 'done')
      setPhase('done'); setRain(true)
      void qc.invalidateQueries()
    } catch (e) {
      setErr(explainError(e)) // 11.8.5: gas / cancelled / pending / generic, never raw
      setPhase('review')
    }
  }

  const inSym = side === 'buy' ? 'eth' : 'wif'
  const outSym = side === 'buy' ? 'wif' : 'eth'
  const Coin = ({ sym }: { sym: string }) => sym === 'wif'
    ? <span className="swap__coin"><Token size={22} /> wif</span>
    : <span className="swap__coin swap__coin--eth">eth</span>

  const rate = inN && outN ? (side === 'buy' ? outN / inN : inN / outN) : undefined
  const rateLine = rate ? <>price: 1 eth = <Tick value={rate} format={fmt} /> wif</> : q.isError ? 'no price right now' : 'getting the price…'
  const btnLabel = tooMuch ? `not enough ${inSym}` : amount <= 0 ? 'enter an amount' : !q.data ? (q.isError ? 'no quote right now' : 'getting a quote…') : side === 'buy' ? 'buy wif' : 'sell wif'

  return (
    <div className={`swap swap--min ${compact ? 'swap--compact' : ''}`}>
      {rain && <CoinRain onDone={() => setRain(false)} />}
      {preset?.reason && <div className="swap__reason"><Token size={18} /> {preset.reason}</div>}

      <AnimatePresence mode="wait" initial={false}>
      {phase === 'edit' ? (
        <motion.div key="edit" className="swap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="swapcard">
            <div className="swapcard__leg">
              <div className="swap__row-head">
                <span>{exactOut ? 'pay, about' : 'pay'}</span>
                {isConnected && <span className="num">{balIn === undefined ? '…' : side === 'buy' ? fmtEth(balIn) : fmt(balIn)} {inSym}{!exactOut && <> · <button className="linkbtn" onClick={setMax}>max</button></>}</span>}
              </div>
              <div className="swap__field">
                {exactOut
                  ? <output className={`swap__out num ${q.isFetching ? 'is-loading' : ''}`}>{inN !== undefined ? fmtEth(inN) : '…'}</output>
                  : <input inputMode="decimal" value={input} aria-label={`${inSym} amount`} placeholder="0"
                      onChange={e => setInput(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))} />}
                <motion.span key={`in-${inSym}`} className="swap__coin-slot" initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 24 }}><Coin sym={inSym} /></motion.span>
              </div>
              <div className="swap__usd"><Usd value={usdIn} /></div>
            </div>
            <motion.button className="swap__arrow" onClick={flip} disabled={exactOut} aria-label="flip direction" whileTap={{ scale: 0.88 }}
              animate={{ rotate: side === 'buy' ? 0 : 180 }} transition={{ type: 'spring', stiffness: 320, damping: 18 }}><Icon name="swap" size={16} /></motion.button>
            <div className="swapcard__leg">
              <div className="swap__row-head"><span>{exactOut ? 'get' : 'get, about'}</span>{isConnected && balOut !== undefined && <span className="num">{side === 'buy' ? fmt(balOut) : fmtEth(balOut)} {outSym}</span>}</div>
              <div className="swap__field">
                <output className={`swap__out num ${q.isFetching ? 'is-loading' : ''}`} aria-live="polite">
                  {exactOut ? fmt(amount) : amount <= 0 ? '0' : outN !== undefined ? (side === 'buy' ? fmt(outN) : fmtEth(outN)) : q.isError ? '—' : '…'}
                </output>
                <motion.span key={`out-${outSym}`} className="swap__coin-slot" initial={{ y: -14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 24 }}><Coin sym={outSym} /></motion.span>
              </div>
              <div className="swap__usd"><Usd value={usdOut} /></div>
            </div>
          </div>

          {TX_ENABLED
            ? <button className="btn btn--dark btn--block btn--xl" disabled={amount <= 0 || !q.data || tooMuch} onClick={() => setPhase('review')}>{btnLabel}</button>
            : <button className="btn btn--dark btn--block btn--xl" disabled aria-describedby="swap-soon">swaps open soon</button>}
          {rateRow()}
        </motion.div>
      ) : (
        <motion.div key="review" className="swap" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
          <div className="swap__review">
            <div className="swap__review-row"><span className="muted small">pay{exactOut ? ' at most' : ''}</span><b className="num">{exactOut ? fmtEth(limitIn ?? 0) : side === 'buy' ? fmtEth(inN ?? 0) : fmt(inN ?? 0, 2)} {inSym}</b><Usd value={usdIn} /></div>
            <div className="swap__review-row"><span className="muted small">get{exactOut ? '' : ', at least'}</span><b className="num">{exactOut ? fmt(amount) : side === 'buy' ? fmt(limitOut ?? 0) : fmtEth(limitOut ?? 0)} {outSym}</b><Usd value={usdOut} /></div>
          </div>
          {stepLabels.length > 1 && <ol className="txsteps txsteps--swap">
            {stepLabels.map((l, i) => {
              const s = steps[i] ?? 'todo'
              return <li key={l} className={`is-${s}`}><span className="txsteps__n">{s === 'done' || s === 'skip' ? <Icon name="check" size={12} /> : s === 'active' ? <span className="spinner" /> : i + 1}</span>{l}{s === 'skip' && <span className="muted small"> · already set</span>}</li>
            })}
          </ol>}
          {phase !== 'done' && <PayingFrom className="swap__payer" />}
          {phase !== 'done' && choice && receiveIn && (
            <div className="swap__recv" data-testid="receive-in">
              <span className="muted small">receive in</span>
              <div className="seg" role="radiogroup" aria-label="receive in">
                {([['embedded', choice.embedded], ['linked', choice.linked]] as const).map(([k, a]) => (
                  <button key={k} role="radio" aria-checked={receiveIn === a} className={`seg__btn ${receiveIn === a ? 'is-on' : ''}`} disabled={phase === 'sending'} onClick={() => setReceivePick(a)}>
                    {k} <span className="mono">{shortA(a)}</span>
                  </button>
                ))}
              </div>
              {topUpOk && (
                <label className="swap__topup small" data-testid="topup">
                  <input type="checkbox" checked={topUp} disabled={phase === 'sending'} onChange={e => setTopUpPick(e.target.checked)} />
                  <span><b>{TOPUP_LABEL}</b> <span className="muted">{topUpNote(choice.embedded)}</span> <CopyAddr address={choice.embedded} /></span>
                </label>
              )}
            </div>
          )}
          {err && <div className="txerr" role="alert" data-testid="tx-error"><p className="txerr__line small">{err}</p>{err === GAS_LINE && address && <GasWallet address={address} />}</div>}
          {phase === 'done' ? (
            <div className="swap__done">
              <img src="/brand/wif-coin-256.png" width={56} height={56} alt="" />
              <b>done</b>
              {hash && <a className="small mono" href={`${robinhoodChain.blockExplorers?.default.url}/tx/${hash}`} target="_blank" rel="noreferrer">{hash.slice(0, 10)}…{hash.slice(-6)}</a>}
              <button className="btn btn--ghost btn--block" onClick={() => { setPhase('edit'); setSteps([]); onDone?.() }}>close</button>
            </div>
          ) : (
            <div className="swap__actions">
              <button className="btn btn--ghost" disabled={phase === 'sending'} onClick={() => { setPhase('edit'); setErr(null) }}>back</button>
              <button className="btn btn--dark btn--lg" disabled={phase === 'sending' || !q.data} onClick={execute}>
                {phase === 'sending' ? 'confirm in your wallet…' : 'confirm'}
              </button>
            </div>
          )}
          {rateRow()}
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  )

  /** One line for the rate; slippage, route, pool and the token address sit behind "details".
   *  A plain render helper, not a component: as a component declared inside SwapPanel it got a new identity on every
   *  render (the "updated Ns ago" tick re-renders once a second), so React remounted it and "details" snapped shut. */
  function rateRow() {
    const open = detailsOpen, setOpen = setDetailsOpen
    return (
      <div className="swap__rate">
        <div className="swap__rate-line">
          <span className="num small" id="swap-soon">{rateLine}{q.data && ago !== undefined && <span className="muted">, {q.isFetching ? 'updating…' : `updated ${ago}s ago`}</span>}</span>
          <button className="linkbtn small" aria-expanded={open} onClick={() => setOpen(o => !o)}>details <Icon name={open ? 'up' : 'down'} size={12} /></button>
        </div>
        {open && <div className="swap__details">
          <dl className="swap__facts">
            <div><dt>max slippage</dt><dd>
              <div className="picker__presets">
                {SLIPPAGES.map(b => <button key={b} className={`pill pill--sm ${slip === b && !custom ? 'is-on' : ''}`} onClick={() => { setSlip(b); setCustom('') }}>{b / 100}%</button>)}
                <label className={`pill pill--sm pill--input ${custom ? 'is-on' : ''}`}>
                  <input inputMode="decimal" placeholder="other" value={custom} aria-label="custom slippage percent"
                    onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ''); setCustom(v); const n = Number(v); if (n > 0 && n <= 50) setSlip(Math.round(n * 100)) }} />%
                </label>
              </div>
            </dd></div>
            <div><dt>{exactOut ? 'max you pay' : 'min. you get'}</dt><dd className="num">{exactOut ? (limitIn !== undefined ? `${fmtEth(limitIn)} eth` : '—') : limitOut !== undefined ? `${side === 'buy' ? fmt(limitOut) : fmtEth(limitOut)} ${outSym}` : '—'}</dd></div>
            <div><dt>price impact</dt><dd className={`num ${impact !== undefined && impact > 0.03 ? 'error' : ''}`}>{impact === undefined ? '—' : impact < 0.0001 ? '< 0.01%' : `${(impact * 100).toFixed(2)}%`}</dd></div>
            <div><dt>pool fee</dt><dd>{SWAP_POOL_FEE_BPS / 100}%, included</dd></div>
            <div><dt>route</dt><dd>uniswap v4 eth/wif{kq.data?.alt ? <span className="muted"> · another route is a bit better now</span> : null}</dd></div>
            <div><dt>pool</dt><dd className="mono small" title={POOL_ID}>{POOL_ID.slice(0, 10)}…{POOL_ID.slice(-6)}</dd></div>
            <div><dt>token</dt><dd><CopyAddress address={WIF_TOKEN} label="$wif" /></dd></div>
          </dl>
          {highSlip && <p className="warn small" role="alert"><Icon name="shield" size={14} /> over 3%: the price can move a lot</p>}
          {stale && <p className="muted small">usd price may be a little old</p>}
          <p className="small muted"><a href={`https://app.uniswap.org/swap?chain=robinhood&outputCurrency=${WIF_TOKEN}`} target="_blank" rel="noreferrer">uniswap</a> · <a href={DEXSCREENER} target="_blank" rel="noreferrer">chart</a></p>
        </div>}
      </div>
    )
  }
}

function useDebounce<T>(v: T, ms: number) {
  const [d, setD] = useState(v)
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms])
  return d
}

/** Exact-out amount for a "not enough WIF" shortcut: the shortfall plus a 1.3% buffer, rounded up to a whole WIF. */
export const shortfallWif = (need: number, have: number) => {
  const short = Math.max(0, need - have)
  return short > 0 ? Math.ceil(Number(formatUnits(withBuffer(parseUnits(short.toFixed(6), WIF_DECIMALS)), WIF_DECIMALS))) : 0
}
/** "Get WIF for Plus": 1,500 WIF + buffer, about 1,520 WIF. */
export const plusTopUp = (price: number) => Math.ceil(Number(formatUnits(withBuffer(parseUnits(String(price), WIF_DECIMALS)), WIF_DECIMALS)))

/** Shown in money sheets when the wallet holds less WIF than the action needs. Opens the swap with an exact-out quote. */
export function LowBalance({ need, what = 'this' }: { need: number; what?: string }) {
  const { address } = useAnyAccount()
  const isConnected = !!address
  const bal = useWifBalance(address)
  const { openSheet } = useStore()
  if (!isConnected || bal.value === undefined || bal.value >= need) return null
  const get = shortfallWif(need, bal.value)
  return (
    <div className="lowbal" role="status">
      <span>you have <b className="num">{fmt(bal.value)} wif</b>, {what} needs <b className="num">{fmt(need)}</b>.</span>
      <button className="btn btn--ghost btn--sm" onClick={() => openSheet({ type: 'swap', wifOut: get, reason: `get ${fmt(get)} wif for ${what}` })}><Token size={16} /> get {fmt(get)} wif</button>
    </div>
  )
}
