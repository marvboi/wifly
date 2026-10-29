/**
 * /dca: recurring WIF buys with WiflyDCA (ETH -> WIF on the WIF/ETH pool). Reached from the swap page and from
 * companion cards (which prefill this form through the URL). Creating a plan is free; the keeper only runs scheduled
 * buys for Plus members (5-day grace). Pause, edit, top up, withdraw and cancel always work, Plus or not.
 * Live (VITE_DCA_ADDRESS set + the backend sees the contract): every change is a transaction from your wallet, then the
 * hash goes to the backend, which re-reads the chain. Preview: the plan is saved in the app only and nothing is sent.
 */
import { PayingFrom } from '../components/Payer'
import { useMemo, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { encodeFunctionData, parseEther, type Hex } from 'viem'
import { PageHead } from '../components/Shell'
import { DCA_ADDRESS, EXPLORER, TX_ENABLED } from '../config'
import { WIFLY_DCA_ABI } from '../contracts/wiflyDca'
import { call } from '../companion/agentApi'
import { utcLabel } from '../lib/tzLabel'
import { useWifPrice } from '../lib/price'
import { explainError, failArgs, useSendPlan, type Plan } from '../lib/wifly'
import { PREVIEW_NOTE, useStore } from '../state/store'
import { useSession } from '../api/session'

type Every = 'hour' | 'day' | 'week' | 'month'
type PlanView = {
  id: number; chainPlanId: string | null; balanceEth: number; perBuyEth: number; perBuyUsd: number | null; intervalS: number
  maxBuys: number; buysDone: number; buysLeft: number; nextAt: number | null; slippageBps: number; minWifPerEth: number
  spentEth: number; wifBought: number; status: 'active' | 'paused' | 'plus_expired' | 'finished' | 'empty' | 'cancelled'; pauseReason: string | null; txHash: string | null; preview: boolean
}
type Fill = { id: number; planId: number | null; ethIn: number; wifOut: number; price: number; txHash: string; at: number }
type State = { live: boolean; contract: string | null; plans: PlanView[]; closed: PlanView[]; fills: Fill[]; error?: string }

const SEC: Record<Every, number> = { hour: 3600, day: 86400, week: 7 * 86400, month: 30 * 86400 }
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const STATUS: Record<PlanView['status'], string> = { active: 'active', paused: 'paused', plus_expired: 'paused, plus expired', finished: 'finished', empty: 'out of eth', cancelled: 'cancelled' }
const f = (n: number, d = 6) => Number(n.toFixed(d)).toLocaleString('en-US', { maximumFractionDigits: d })
const everyText = (s: number) => s % SEC.week === 0 && s / SEC.week === 1 ? 'every week' : s === SEC.day ? 'every day' : s === SEC.hour ? 'every hour' : s === SEC.month ? 'every month' : `every ${f(s / 3600, 1)}h`

const PER_DEFAULT = { usd: '5', eth: '0.01' } as const
/** Next local wall-clock time for the schedule (seconds, unix). */
function firstAt(every: Every, weekday: number, time: string): number {
  const [h, m] = time.split(':').map(Number)
  const d = new Date(); d.setSeconds(0, 0)
  if (every === 'hour') { d.setMinutes(m || 0); if (d.getTime() <= Date.now()) d.setHours(d.getHours() + 1); return Math.floor(d.getTime() / 1000) }
  d.setHours(h || 0, m || 0)
  if (every === 'week') { const add = (weekday - d.getDay() + 7) % 7; d.setDate(d.getDate() + add) }
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + (every === 'week' ? 7 : every === 'month' ? 30 : 1))
  return Math.floor(d.getTime() / 1000)
}

export function DCA() {
  const [q] = useSearchParams()
  const qc = useQueryClient()
  const { toast } = useStore()
  const send = useSendPlan()
  const { ethUsd, stale } = useWifPrice()
  const { me, guest } = useSession()
  const { openSheet } = useStore()
  // only signed-in people have plans, and only once the contract exists: no request otherwise (it would just 401)
  const st = useQuery({ queryKey: ['dca', me?.handle], queryFn: () => call<State>('/dca'), refetchInterval: 30_000, enabled: !!DCA_ADDRESS && !!me })
  // live = the backend says live AND this build can send: no "deposit … and start" (or any send) on a build with sends off
  const live = !!st.data?.live && !!DCA_ADDRESS && TX_ENABLED
  // a live contract but a build with sends off: no save either (the backend wants the createPlan tx), so say so on the button
  const sendsOff = !!st.data?.live && !!DCA_ADDRESS && !TX_ENABLED
  // stored with the plan so the keeper can keep wall-clock times; never shown (a raw zone name reads badly)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

  const [deposit, setDeposit] = useState(q.get('deposit') ?? '0.05')
  const [unit, setUnit] = useState<'usd' | 'eth'>(q.get('eth') ? 'eth' : 'usd')
  const [per, setPer] = useState(q.get('eth') ?? q.get('usd') ?? PER_DEFAULT[q.get('eth') ? 'eth' : 'usd'])
  const pickUnit = (u: 'usd' | 'eth') => { if (u === unit) return; setUnit(u); setPer(PER_DEFAULT[u]) }
  const [every, setEvery] = useState<Every>((['hour', 'day', 'week', 'month'].includes(q.get('every') ?? '') ? q.get('every') : 'week') as Every)
  const [weekday, setWeekday] = useState(Number(q.get('weekday') ?? 1))
  const [time, setTime] = useState(`${String(Number(q.get('hour') ?? 9)).padStart(2, '0')}:${String(Number(q.get('minute') ?? 0)).padStart(2, '0')}`)
  const [maxBuys, setMaxBuys] = useState('0')
  const [slip, setSlip] = useState('1')
  const [floor, setFloor] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [amt, setAmt] = useState<Record<number, string>>({})

  const perEth = unit === 'eth' ? Number(per) : ethUsd ? Number(per) / ethUsd : NaN
  const dep = Number(deposit)
  const buys = perEth > 0 ? Math.floor(dep / perEth + 1e-9) : 0
  const problem = !(dep > 0) ? 'enter a deposit' : !(perEth > 0) ? (unit === 'usd' && !ethUsd ? 'waiting for the eth price' : 'enter an amount per buy')
    : perEth > dep ? 'the amount per buy has to fit in the deposit' : !(Number(slip) >= 0 && Number(slip) <= 10) ? 'the slippage guard is up to 10%'
    : !Number(slip) && !(Number(floor) > 0) ? 'set a slippage guard or a price floor' : null
  const summary = useMemo(() => `buy ${unit === 'usd' ? `$${per}` : `${per} eth`} of wif ${every === 'week' ? `every ${DAYS[weekday]}` : `every ${every}`}${every === 'hour' ? '' : ` at ${time}`}`, [unit, per, every, weekday, time])

  const refresh = (s?: State) => { if (s && !s.error) qc.setQueryData(['dca', me?.handle], s); void qc.invalidateQueries({ queryKey: ['dca'] }) }

  const create = async () => {
    if (problem) return
    setBusy('create')
    try {
      const startAt = firstAt(every, weekday, time)
      const body = { depositEth: dep, perBuyEth: Number(perEth.toFixed(12)), perBuyUsd: unit === 'usd' ? Number(per) : undefined, intervalS: SEC[every], maxBuys: Number(maxBuys) || 0,
        firstAt: startAt * 1000, tz, slippageBps: Math.round(Number(slip) * 100), minWifPerEth: Number(floor) || 0 }
      if (!live) { const s = await call<State>('/dca/plans', 'POST', body); if (s.error) throw new Error(s.error); refresh(s); toast('plan saved', PREVIEW_NOTE); return }
      const p = { amountPerBuy: parseEther(String(body.perBuyEth)), interval: body.intervalS, maxBuys: body.maxBuys, minWifPerEth: parseEther(String(body.minWifPerEth)), maxSlippageBps: body.slippageBps, keeperTip: 0n }
      const plan: Plan = { label: summary, pull: 0n, to: DCA_ADDRESS, value: parseEther(deposit), data: encodeFunctionData({ abi: WIFLY_DCA_ABI, functionName: 'createPlan', args: [p, startAt] }) }
      const r = await send(plan)
      if (!r.sent) { toast(...failArgs(r)); return }
      const s = await call<State>('/dca/plans', 'POST', { txHash: r.hash, perBuyUsd: body.perBuyUsd, tz })
      refresh(s); toast('plan created', 'confirmed onchain.')
    } catch (e) { toast('not saved', explainError(e)) } finally { setBusy(null) }
  }

  /** One control on a plan: the wallet sends it (live), then the backend records it. */
  const act = async (p: PlanView, action: 'pause' | 'resume' | 'edit' | 'topup' | 'withdraw' | 'cancel', extra: { amountEth?: number; perBuyEth?: number; intervalS?: number; maxBuys?: number; slippageBps?: number; minWifPerEth?: number } = {}) => {
    setBusy(`${p.id}:${action}`)
    try {
      let txHash: Hex | undefined
      if (live && p.chainPlanId) {
        const id = BigInt(p.chainPlanId)
        const data = action === 'pause' || action === 'resume' ? encodeFunctionData({ abi: WIFLY_DCA_ABI, functionName: 'setPlanPaused', args: [id, action === 'pause'] })
          : action === 'edit' ? encodeFunctionData({ abi: WIFLY_DCA_ABI, functionName: 'updatePlan', args: [id, { amountPerBuy: parseEther(String(extra.perBuyEth)), interval: extra.intervalS!, maxBuys: extra.maxBuys!, minWifPerEth: parseEther(String(extra.minWifPerEth ?? 0)), maxSlippageBps: extra.slippageBps!, keeperTip: 0n }] })
          : action === 'topup' ? encodeFunctionData({ abi: WIFLY_DCA_ABI, functionName: 'topUp', args: [id] })
          : action === 'cancel' ? encodeFunctionData({ abi: WIFLY_DCA_ABI, functionName: 'cancelPlan', args: [id] })
          : extra.amountEth ? encodeFunctionData({ abi: WIFLY_DCA_ABI, functionName: 'withdraw', args: [id, parseEther(String(extra.amountEth))] })
          : encodeFunctionData({ abi: WIFLY_DCA_ABI, functionName: 'withdrawAll', args: [id] })
        const r = await send({ label: `${action} plan`, pull: 0n, to: DCA_ADDRESS, data, value: action === 'topup' ? parseEther(String(extra.amountEth ?? 0)) : undefined })
        if (!r.sent) { toast(...failArgs(r)); return }
        txHash = r.hash
      }
      const s = await call<State>(`/dca/plans/${p.id}/${action}`, 'POST', { ...extra, txHash })
      if (s.error) { toast('not done', s.error); return }
      refresh(s); toast(action === 'edit' ? 'plan updated' : action === 'topup' ? 'topped up' : action === 'withdraw' ? 'withdrawn' : action === 'cancel' ? 'plan cancelled' : action === 'pause' ? 'paused' : 'resumed', live ? 'confirmed onchain.' : PREVIEW_NOTE)
    } catch (e) { toast('not done', explainError(e)) } finally { setBusy(null) }
  }

  const data = st.data
  if (!me) return (
    <>
      <PageHead title="recurring buys" back />
      <section className="soon-card card">
        <h2 className="soon-card__title">buy wif on a schedule.</h2>
        <p className="muted">sign in to set up a plan, like $5 of wif every monday.</p>
        <div className="soon-card__actions"><button className="btn btn--dark" onClick={() => openSheet({ type: 'signin' })}>sign in</button></div>
      </section>
    </>
  )
  if (guest) return (
    <>
      <PageHead title="recurring buys" back />
      <section className="soon-card card" data-testid="dca-guest">
        <h2 className="soon-card__title">buy wif on a schedule.</h2>
        <p className="muted">link a wallet, x or email first. plans need an account you can come back to.</p>
        <div className="soon-card__actions"><button className="btn btn--dark" onClick={() => openSheet({ type: 'link' })}>link an account</button></div>
      </section>
    </>
  )
  return (
    <>
      <PageHead title="recurring buys" back />
      <div className="dca">
        {!live && st.data && <div className="card card--paper" data-testid="dca-preview"><b>preview</b><span className="muted">plans are saved in wifly and nothing is sent onchain on this build.</span></div>}

        <section className="card">
          <b>new plan</b>
          <label className="field"><span className="field__label">deposit (eth)</span><span className="field__input"><input inputMode="decimal" value={deposit} onChange={e => setDeposit(e.target.value)} /></span></label>
          <div className="seg"><button className={unit === 'usd' ? 'is-on' : ''} onClick={() => pickUnit('usd')}>per buy in $</button><button className={unit === 'eth' ? 'is-on' : ''} onClick={() => pickUnit('eth')}>per buy in eth</button></div>
          <label className="field"><span className="field__label">each buy ({unit === 'usd' ? '$' : 'eth'}){unit === 'usd' && perEth > 0 ? ` ≈ ${f(perEth, 6)} eth${stale ? ' (price may be out of date)' : ''}` : ''}</span><span className="field__input"><input inputMode="decimal" value={per} onChange={e => setPer(e.target.value)} /></span></label>
          <div className="seg">{(['hour', 'day', 'week', 'month'] as Every[]).map(e => <button key={e} className={every === e ? 'is-on' : ''} onClick={() => setEvery(e)}>{e === 'day' ? 'daily' : `${e}ly`}</button>)}</div>
          {every === 'week' && <div className="dca__days">{DAYS.map((d, i) => <button key={d} className={`chip ${weekday === i ? 'chip--ink' : ''}`} onClick={() => setWeekday(i)}>{d.slice(0, 3)}</button>)}</div>}
          {every !== 'hour' && <label className="field"><span className="field__label">time (your local time, {utcLabel()})</span><span className="field__input"><input type="time" value={time} onChange={e => setTime(e.target.value)} /></span></label>}
          <details className="dca__adv">
            <summary>advanced settings</summary>
            <div className="dca__row">
              <label className="field"><span className="field__label">max buys (0 = until empty)</span><span className="field__input"><input inputMode="numeric" value={maxBuys} onChange={e => setMaxBuys(e.target.value)} /></span></label>
              <label className="field"><span className="field__label">slippage guard %</span><span className="field__input"><input inputMode="decimal" value={slip} onChange={e => setSlip(e.target.value)} /></span></label>
            </div>
            <label className="field"><span className="field__label">price floor, wif per 1 eth (optional)</span><span className="field__input"><input inputMode="decimal" value={floor} onChange={e => setFloor(e.target.value)} placeholder="none" /></span></label>
          </details>
          <span className="muted">{summary}. {buys > 0 ? `${buys} buys from this deposit.` : ''} scheduled buys run for wifly plus members. you can pause, top up or withdraw any time.</span>
          <PayingFrom />
          <button className="btn btn--lg btn--neon" disabled={!!problem || !!busy || sendsOff} onClick={create}>{busy === 'create' ? 'waiting…' : problem ?? (sendsOff ? 'sending is off on this build' : live ? `deposit ${deposit} eth and start` : 'save plan')}</button>
        </section>

        <section className="card">
          <b>your plans</b>
          {st.isLoading ? <span className="muted">loading…</span> : !data?.plans.length ? <span className="muted">no plans yet.</span> : data.plans.map(p => (
            <div key={p.id} className="dca__plan">
              <div className="dca__plan-head"><b>{p.perBuyUsd ? `$${f(p.perBuyUsd, 2)}` : `${f(p.perBuyEth)} eth`} {everyText(p.intervalS)}</b><span className={`chip-soft ${p.status === 'plus_expired' ? 'is-warn' : ''}`}>{STATUS[p.status]}</span></div>
              <span className="muted">{f(p.balanceEth)} eth deposited · {p.buysLeft} buys left · {p.buysDone} done · {f(p.wifBought, 2)} wif bought{p.nextAt && p.status === 'active' ? ` · next ${new Date(p.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }).toLowerCase()}` : ''}</span>
              {p.status === 'plus_expired' && <span className="muted">scheduled buys need plus. <Link to="/plus">renew plus</Link> to resume, or withdraw your eth any time.</span>}
              <div className="dca__ctl">
                {p.status === 'active' && <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => act(p, 'pause')}>pause</button>}
                {(p.status === 'paused' || p.status === 'plus_expired') && <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => act(p, 'resume')}>resume</button>}
                <button className="btn btn--ghost btn--sm" title="apply the amount, schedule and guards from the form above" disabled={!!busy || !!problem} onClick={() => act(p, 'edit', { perBuyEth: Number(perEth.toFixed(12)), intervalS: SEC[every], maxBuys: Number(maxBuys) || 0, slippageBps: Math.round(Number(slip) * 100), minWifPerEth: Number(floor) || 0 })}>edit from form</button>
                <span className="field__input dca__amt"><input inputMode="decimal" placeholder="eth" value={amt[p.id] ?? ''} onChange={e => setAmt(v => ({ ...v, [p.id]: e.target.value }))} /></span>
                <button className="btn btn--ghost btn--sm" disabled={!!busy || !(Number(amt[p.id]) > 0)} onClick={() => act(p, 'topup', { amountEth: Number(amt[p.id]) })}>top up</button>
                <button className="btn btn--ghost btn--sm" disabled={!!busy || !(p.balanceEth > 0)} onClick={() => act(p, 'withdraw', Number(amt[p.id]) > 0 ? { amountEth: Number(amt[p.id]) } : {})}>{Number(amt[p.id]) > 0 ? 'withdraw' : 'withdraw all'}</button>
                <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => { if (confirm('cancel this plan? the eth left comes back to your wallet.')) void act(p, 'cancel') }}>cancel</button>
              </div>
            </div>
          ))}
        </section>

        {!!data?.fills.length && <section className="card">
          <b>fills</b>
          {data.fills.map(x => <span key={x.id} className="dca__fill"><span>{f(x.ethIn)} eth → {f(x.wifOut, 2)} wif</span><span className="muted">{new Date(x.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()}</span><a className="muted" href={`${EXPLORER}/tx/${x.txHash}`} target="_blank" rel="noreferrer">tx</a></span>)}
        </section>}
        <Link className="muted" to="/swap">one-off swap instead →</Link>
      </div>
    </>
  )
}
