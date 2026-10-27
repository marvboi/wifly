import { useAnyAccount } from '../auth/privyBridge'
/**
 * "This week's pot" card and the weekly reward Claim card (Vote page).
 * Live reads: currentEpoch, epochEndsAt, epochs(epoch).leader, epochPot (communityPot), winnerShareBps / voterShareBps,
 * pendingVoterReward(epoch, voter). Claim sends claimVoterReward(epoch) per closed week, credited to the Wifly balance.
 * Weeks are closed by anyone calling finalizeEpoch(epoch, leader); our backend keeper does it when WEEK_KEEPER_ENABLED=true.
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { LIVE, TX_ENABLED } from '../config'
import { failTitle, plans, useClaimableRewards, useEpochState, useSendPlan } from '../lib/wifly'
import { useStore } from '../state/store'
import { Amount } from './Bits'
import { Icon } from './Icon'
import { Mascot } from './Mascot'
import { Tick } from './Delight'
import { useSession } from '../api/session'

const WEEK = 604_800
const nowS = () => Math.floor(Date.now() / 1000)
const weekEnd = (epoch: bigint) => new Date(Number(epoch + 1n) * WEEK * 1000)
const weekLabel = (epoch: bigint) => `week ending ${weekEnd(epoch).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`

function useCountdown(endsAt: number) {
  const [t, setT] = useState(nowS())
  useEffect(() => { const i = setInterval(() => setT(nowS()), 1000); return () => clearInterval(i) }, [])
  const s = Math.max(0, endsAt - t)
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60, over: s === 0 }
}

export function WeekPotCard() {
  const ep = useEpochState()
  const cur = BigInt(Math.floor(nowS() / WEEK))
  const endsAt = ep?.endsAt ?? Number(cur + 1n) * WEEK
  const c = useCountdown(endsAt)
  const pot = ep?.pot ?? 0
  const w = ep?.winnerShare ?? 0.5, v = ep?.voterShare ?? 0.5
  const liveLeader = ep?.leader && !/^0x0{40}$/i.test(ep.leader) ? ep.leader : undefined
  return (
    <section className="weekpot card" aria-label="this week’s community pot">
      <div className="weekpot__head">
        <span className="eyebrow">this week’s community pot{LIVE ? ' · live' : ''}</span>
        <div className="weekpot__clock" aria-label="time left this week">
          {[['d', c.d], ['h', c.h], ['m', c.m], ['s', c.s]].map(([k, n]) => <span key={k as string}><b className="num"><Tick value={n as number} format={x => String(x).padStart(2, '0')} /></b><i>{k}</i></span>)}
        </div>
      </div>
      <div className="weekpot__amount display-num">{pot > 0 ? <Amount value={pot} size={30} /> : <span className="muted">empty for now</span>}</div>
      <div className="weekpot__lead">
        <span className="pot-split__k">leading now</span>
        {liveLeader ? <span className="mono small">{liveLeader.slice(0, 6)}…{liveLeader.slice(-4)}</span> : <span className="muted small">no votes yet</span>}
      </div>
      <ul className="weekpot__rule">
        <li><b className="num">{Math.round(w * 100)}%</b> to the top-voted creator</li>
        <li><b className="num">{Math.round(v * 100)}%</b> shared by that creator’s voters, by how much each voted</li>
        <li>nobody voted? the whole pot rolls over to next week</li>
      </ul>
    </section>
  )
}

type Item = { epoch: bigint; amount: number }
export function ClaimRewards() {
  const { me } = useSession()
  const any = useAnyAccount().address
  const address = (any ?? (me?.address || undefined)) as `0x${string}` | undefined
  const ep = useEpochState()
  const live = useClaimableRewards(ep?.epoch, address)
  const items: Item[] = live.items
  const total = items.reduce((n, x) => n + x.amount, 0)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const send = useSendPlan()
  const { toast } = useStore()

  const claim = async () => {
    if (!TX_ENABLED) return
    let got = 0
    for (const [i, it] of items.entries()) {
      setBusy(`claiming ${weekLabel(it.epoch)} (${i + 1}/${items.length})…`)
      const r = await send(plans.claimVoterReward(it.epoch))
      if (!r.sent) { toast(failTitle(r), r.reason); break }
      got += it.amount
    }
    setBusy(null); setConfirm(false)
    if (got > 0) toast(`${got.toLocaleString('en-US', { maximumFractionDigits: 2 })} WIF added to your balance`, 'it’s in your wifly balance. withdraw any time from your wallet page')
    live.refetch()
  }

  let body: React.ReactNode
  if (!me && !address) body = <p className="muted small">sign in to see rewards from weeks you voted in.</p>
  else if (!address) body = <p className="muted small">add a wallet to see rewards from weeks you voted in.</p>
  else if (live.loading) body = <p className="muted small">checking past weeks…</p>
  else if (!items.length) body = (
    <div className="claimbox__empty"><Mascot size={36} tile={false} mood="think" /><p className="muted small">nothing to claim yet.</p></div>
  )
  else body = (
    <ul className="claimbox__list">{items.map(it => <li key={String(it.epoch)}><span className="small">{weekLabel(it.epoch)}</span><Amount value={it.amount} size={14} usd={false} /></li>)}</ul>
  )

  return (
    <section className="claimbox card" aria-label="your weekly rewards">
      <div className="claimbox__head">
        <div><span className="eyebrow">your rewards</span><div className="claimbox__total">{items.length ? <Amount value={total} size={20} /> : <span className="muted">0 WIF</span>}</div></div>
        <motion.button whileTap={{ scale: 0.96 }} className="btn btn--dark" disabled={!items.length || !!busy} onClick={() => setConfirm(true)}>
          <Icon name="trophy" size={16} /> {items.length ? 'claim' : 'nothing to claim'}
        </motion.button>
      </div>
      {body}
      <AnimatePresence>
        {confirm && items.length > 0 && (
          <motion.div className="claimbox__confirm" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} role="dialog" aria-label="confirm claim">
            <div className="strong">claim {total.toLocaleString('en-US', { maximumFractionDigits: 2 })} WIF</div>
            <dl className="names-fee">
              <div><dt>weeks</dt><dd>{items.length}</dd></div>
              <div><dt>goes to</dt><dd>your wifly balance</dd></div>
              <div><dt>fee</dt><dd>none · network gas only</dd></div>
            </dl>
            <p className="tiny muted">{items.length > 1 ? `${items.length} quick confirmations, one per week.` : 'one confirmation.'} you can withdraw your balance any time.</p>
            {!TX_ENABLED && <p className="tiny muted"><Icon name="shield" size={12} /> claiming opens when payments go live.</p>}
            <div className="row-gap">
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirm(false)} disabled={!!busy}>not now</button>
              <button className="btn btn--dark btn--sm" onClick={claim} disabled={!TX_ENABLED || !!busy}>{busy ?? 'confirm claim'}</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
