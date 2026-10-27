import { useAnyAccount } from '../auth/privyBridge'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { companion } from '../lib/companion'
import { api } from '../api/client'
import { useSession } from '../api/session'
import { AGENT_CAP_FREE, AGENT_CAP_PLUS, AGENT_READY, DCA_READY, FEE_SPLIT, FREE_AI_MSGS_PER_DAY_FALLBACK, PLUS_PRICE_FALLBACK, PLUS_PRICE_YEAR_FALLBACK } from '../config'
import { FEE_PERCENT_LABEL } from '../lib/fees'
import { plusTopUp } from '../components/Swap'
import { useWifBalance } from '../lib/chain'
import { motion } from 'motion/react'
import { PLUS_NAME } from '../brand'
import { PREVIEW_NOTE, useStore } from '../state/store'
import { failTitle, plans, useNeedsApprove, usePlusStatus, useSendPlan, type PlusPlanId } from '../lib/wifly'
import { PriceTag, Token } from '../components/Bits'
import { FeeSplit } from '../components/FeeSplit'
import { PageHead } from '../components/Shell'
import { Icon, type IconName } from '../components/Icon'
import { PlusBadge, PlusMark } from '../components/BrandSlots'

/** soon: the perk isn't live yet (agent and scheduled buys follow AGENT_READY / DCA_READY), shown with a coming soon pill. */
type Perk = { icon: IconName | 'badge'; title: string; body: string; soon?: boolean }
const perks: Perk[] = [
  { icon: 'badge', title: 'the plus check', body: 'next to your name, everywhere.' },
  { icon: 'sparkle', title: 'the assistant, without the daily limit', body: `free accounts get ${FREE_AI_MSGS_PER_DAY_FALLBACK} questions a day.` },
  { icon: 'agent', title: 'an agent that does things', body: 'say “tip @ana 100”. nothing happens until you confirm.', soon: !AGENT_READY },
  { icon: 'calendar', title: 'buy WIF on a schedule', body: '“$5 of WIF every friday”. pause anytime.', soon: !DCA_READY },
  { icon: 'power', title: `${AGENT_CAP_PLUS.toLocaleString('en-US')} WIF a day for your agent`, body: `up from ${AGENT_CAP_FREE.toLocaleString('en-US')}. you still set the cap.`, soon: !AGENT_READY },
]

const faq: Array<[string, string]> = [
  ['is plus required?', 'no. posting, voting, tipping and your @name are free for everyone.'],
  ['what doesn’t plus buy?', 'plus doesn’t buy votes, the top spot or a better place in the feed.'],
  ['can i stop?', 'yes. plus doesn’t renew unless you turn on auto-renew, and you can turn that off anytime.'],
  ['what happens when it ends?', 'you keep the check for a short grace period. renewing early adds time on top.'],
]

type PlusState = 'none' | 'active' | 'grace' | 'expired'
type PlusView = {
  state: PlusState; plan: PlusPlanId; price: number; plans?: { id: PlusPlanId; price: number; days: number }[]
  expiresAt?: number | null; graceEndsAt?: number | null; graceDays?: number; autoRenew?: boolean; agreedPrice?: number | null
  priceChanged?: boolean; renewsOn?: number | null; signedOut?: boolean
}
const DAY = 86400_000
const fmtDate = (ms?: number | null) => (ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

export function Plus() {
  const { plus: localPlus, toast, openSheet } = useStore()
  const { address } = useAnyAccount()
  const { me } = useSession()
  const qc = useQueryClient()
  const chain = usePlusStatus(localPlus)
  const send = useSendPlan()
  const [busy, setBusy] = useState<string | null>(null)
  const isTeam = !!chain.team && !!address && chain.team.toLowerCase() === address.toLowerCase()
  const name = PLUS_NAME.toLowerCase()
  const wif = useWifBalance(address).value

  const server = useQuery({ queryKey: ['plus', me?.handle], queryFn: () => api<PlusView>('/plus') })
  const monthPrice = chain.live ? chain.price : server.data?.plans?.find(p => p.id === 'month')?.price ?? PLUS_PRICE_FALLBACK
  const yearPrice = chain.live ? chain.yearPrice : server.data?.plans?.find(p => p.id === 'year')?.price ?? PLUS_PRICE_YEAR_FALLBACK

  // Live: the chain is the source of truth (subStatus + autoRenewOf). Otherwise the backend view.
  const v: PlusView = useMemo(() => {
    if (chain.live) {
      const exp = chain.expiry ? chain.expiry * 1000 : null, grace = chain.graceEndsAt ? chain.graceEndsAt * 1000 : null
      const st: PlusState = !exp ? 'none' : chain.active ? 'active' : chain.hasAccess ? 'grace' : 'expired'
      return { state: st, plan: chain.plan, price: chain.plan === 'year' ? yearPrice : monthPrice, expiresAt: exp, graceEndsAt: grace, autoRenew: chain.autoRenew, agreedPrice: chain.maxPrice || null, priceChanged: chain.priceChanged, renewsOn: chain.autoRenew && !chain.priceChanged ? exp : null }
    }
    if (server.data && server.data.state !== 'none') return server.data
    return localPlus ? { state: 'active', plan: 'month', price: monthPrice, expiresAt: Date.now() + 30 * DAY, autoRenew: false } : { state: 'none', plan: 'month', price: monthPrice }
  }, [chain, server.data, localPlus, monthPrice, yearPrice])

  const [plan, setPlan] = useState<PlusPlanId>(v.plan ?? 'month')
  const price = plan === 'year' ? yearPrice : monthPrice
  const [cap, setCap] = useState<number>(v.agreedPrice ?? price)
  const has = v.state === 'active' || v.state === 'grace'
  const shortBy = wif !== undefined && wif < price

  const pay = async (kind: 'buy' | 'renew') => {
    if (!chain.live) { toast('not sent', PREVIEW_NOTE); return }
    if (!chain.team || busy) return
    setBusy(kind)
    try {
      // Receipt first, then the toast and the badge stamp (refetched subStatus flips it).
      const r = await send(plans.plus(chain.team, price, plan))
      if (r.sent) { companion.celebrate('plus', kind === 'renew' ? 'renewed. the check stays green ✓' : undefined); toast(kind === 'renew' ? 'renewed' : `welcome to ${name}`, `confirmed onchain. ${plan === 'year' ? '365' : '30'} more days.`); api('/plus/payments', { method: 'POST', json: { plan, kind, txHash: r.hash } }).catch(() => {}) }
      else toast(failTitle(r), r.reason)
    } finally { setBusy(null) }
  }
  const setAuto = async (on: boolean, agreed = cap) => {
    setBusy('auto')
    try {
      if (chain.live && chain.team) {
        const r = await send(plans.plusAutoRenew(chain.team, plan, on ? agreed : 0))
        if (!r.sent) { toast(failTitle(r), r.reason); return }
      }
      if (me) await api('/plus/auto-renew', { method: 'POST', json: { on, agreedPrice: agreed, plan } }).catch(e => { throw e })
      await qc.invalidateQueries({ queryKey: ['plus'] })
      toast(on ? `auto-renew on, up to ${agreed.toLocaleString()} WIF` : 'auto-renew off', chain.live ? 'saved onchain' : PREVIEW_NOTE)
    } catch (e) { toast('couldn’t change auto-renew', (e as Error).message) } finally { setBusy(null) }
  }
  const getWif = () => { const n = plusTopUp(price); openSheet({ type: 'swap', wifOut: n, reason: `get ${n.toLocaleString()} WIF for ${name} (${price.toLocaleString()} + a small buffer)` }) }


  const needsApprove = useNeedsApprove(price)
  const headline = v.state === 'expired' ? 'your check is paused.' : v.state === 'grace' ? 'renew to keep your check.' : v.state === 'active' ? 'you’re on plus.' : (AGENT_READY ? 'the check, an assistant without limits, and an agent that does things.' : 'the check and an assistant without limits. the agent is coming soon.')
  const stateTag = v.state === 'grace' ? `grace period · ${Math.max(0, Math.ceil(((v.graceEndsAt ?? 0) - Date.now()) / DAY))} days left` : v.state === 'expired' ? 'expired' : v.state === 'active' ? 'active' : null

  return (
    <div className="plus-page plusx">
      <PageHead title={name} back sub="optional. everything else stays free." />

      <section className={`plusx-hero plusx-hero--${v.state}`}>
        <div className="plusx-hero__top">
          {v.state === 'expired'
            ? <span className="plusx-hero__seal is-off" aria-label="no check while expired"><Icon name="close" size={22} /></span>
            : <motion.span key={v.state} className="plusx-hero__seal" initial={{ scale: 1.6, rotate: -18, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 380, damping: 18, delay: 0.15 }}><PlusBadge size={44} variant="hero" title="" /></motion.span>}
          {stateTag && <span className={`plusx-tag plusx-tag--${v.state}`}>{stateTag}</span>}
        </div>
        <h2 className="plusx-hero__title">{headline}</h2>
        <p className="plusx-hero__lede">
          {v.state === 'active' && <>active until <b>{fmtDate(v.expiresAt)}</b>.{v.renewsOn ? <> renews on <b>{fmtDate(v.renewsOn)}</b>.</> : v.autoRenew ? null : ' auto-renew is off.'}</>}
          {v.state === 'grace' && <>it ended on {fmtDate(v.expiresAt)}. you keep the check until <b>{fmtDate(v.graceEndsAt)}</b>. renew before then.</>}
          {v.state === 'expired' && <>it ended on {fmtDate(v.expiresAt)} and the grace period is over. renew anytime to get the check back.</>}
          {v.state === 'none' && <>a monthly or yearly pass, paid in WIF.</>}
        </p>

        {v.priceChanged && (
          <div className="plusx-alert" role="alert">
            <b>the price changed. confirm the new price.</b>
            <p>auto-renew is paused: plus now costs <b>{v.price.toLocaleString()} WIF</b> and you agreed to at most <b>{(v.agreedPrice ?? 0).toLocaleString()} WIF</b>. nothing renews until you confirm.</p>
            <div className="plusx-alert__row">
              <button className="btn btn--dark btn--sm" disabled={!!busy} onClick={() => { setCap(v.price); setAuto(true, v.price) }}>confirm {v.price.toLocaleString()} WIF</button>
              <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => setAuto(false)}>turn auto-renew off</button>
            </div>
          </div>
        )}

        <div className="plusx-buy">
          <div className="seg plusx-seg" role="radiogroup" aria-label="plan">
            <button role="radio" aria-checked={plan === 'month'} className={plan === 'month' ? 'is-on' : ''} onClick={() => { setPlan('month'); setCap(monthPrice) }}>monthly</button>
            <button role="radio" aria-checked={plan === 'year'} className={plan === 'year' ? 'is-on' : ''} onClick={() => { setPlan('year'); setCap(yearPrice) }}>yearly <span className="plusx-pill">2 months free</span></button>
          </div>
          <div className="plusx-price">
            <PriceTag value={price} size={32} />
            <span className="plusx-price__per">{plan === 'year' ? 'per year' : 'per month'}</span>
          </div>
          <button className="btn btn--lg btn--dark btn--block" disabled={isTeam || !!busy} onClick={() => pay(has ? 'renew' : 'buy')}>
            {busy === 'buy' || busy === 'renew' ? 'waiting for confirmation…' : has ? 'renew now' : v.state === 'expired' ? `renew for ${price.toLocaleString()} WIF` : `get plus for ${price.toLocaleString()} WIF`}
          </button>
          <div className="plusx-wallet">
            <span className="small muted"><Token size={16} /> {wif === undefined ? 'connect a wallet to see your WIF' : <>you have <b className="num">{Math.floor(wif).toLocaleString()} WIF</b></>}</span>
            {(shortBy || wif === undefined) && <button className="btn btn--ghost btn--sm" onClick={getWif}>get WIF</button>}
          </div>
          {has && <p className="small muted plusx-note">renewing early adds {plan === 'year' ? '365' : '30'} days to your current end date, so you never lose time.</p>}
          {isTeam && <p className="small muted plusx-note"><Icon name="shield" size={14} /> this is the team wallet. it can’t subscribe to itself.</p>}
        </div>
      </section>

      {has || v.state === 'expired' ? (
        <section className="card plus-auto">
          <div className="card__head"><span className="eyebrow">auto-renew</span>
            <label className="tgl"><input type="checkbox" checked={!!v.autoRenew} disabled={!!busy} onChange={e => setAuto(e.target.checked)} aria-label="auto-renew" /><span /></label>
          </div>
          <p className="muted small">renews from your wallet only at or below your cap. if the price goes up, it asks first.</p>
          <label className="field"><span className="field__label">max price per renewal</span>
            <span className="field__input"><input inputMode="decimal" value={cap || ''} onChange={e => setCap(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} /><span className="muted">WIF</span></span>
          </label>
          {cap < price && <p className="error small">your cap is below the current {plan === 'year' ? 'yearly' : 'monthly'} price ({price.toLocaleString()} WIF), so it would never renew.</p>}
          <div className="plus-auto__row">
            <PriceTag value={cap} size={16} />
            <button className="btn btn--dark btn--sm" disabled={!!busy || cap < price} onClick={() => setAuto(true)}>{v.autoRenew ? 'update cap' : 'turn on auto-renew'}</button>
          </div>
        </section>
      ) : null}

      <h3 className="plusx-h">what you get</h3>
      <ul className="plusx-perks">
        {perks.map(p => (
          <li key={p.title} className="plusx-perk">
            <span className="plusx-perk__icon">{p.icon === 'badge' ? <PlusMark size={20} /> : <Icon name={p.icon} size={20} />}</span>
            <div><div className="plusx-perk__title">{p.title}{p.soon ? <span className="plusx-soon">coming soon</span> : has && <Icon name="check" size={14} />}</div>
            <p className="plusx-perk__body">{p.body}</p></div>
          </li>
        ))}
      </ul>

      <h3 className="plusx-h">where your WIF goes</h3>
      <section className="card plusx-card">
        <p className="muted small">paid to the wifly team. the usual {FEE_PERCENT_LABEL} fee goes {FEE_SPLIT.pot}% to the weekly community pot and {FEE_SPLIT.burn}% is burned.</p>
        <FeeSplit amount={price} recipientLabel="wifly team gets" />
      </section>

      <h3 className="plusx-h">how paying works</h3>
      <ol className="plusx-steps">
        <li className={needsApprove ? '' : 'is-done'}>
          <span className="plusx-steps__n">{needsApprove ? 1 : <Icon name="check" size={12} />}</span>
          <div><b>allow {price.toLocaleString()} WIF</b><p className="small muted">{needsApprove ? 'your wallet asks once.' : 'already done.'}</p></div>
        </li>
        <li>
          <span className="plusx-steps__n">2</span>
          <div><b>confirm the payment</b><p className="small muted">plus turns on in a few seconds.</p></div>
        </li>
      </ol>

      <h3 className="plusx-h">questions</h3>
      <div className="plusx-faq">
        {faq.map(([q, a]) => <details key={q}><summary>{q}<Icon name="chevron" size={14} /></summary><p className="small muted">{a}</p></details>)}
      </div>
    </div>
  )
}
