import { useAnyAccount } from '../auth/privyBridge'
import { InfoTip } from '../components/InfoTip'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { companion } from '../lib/companion'
import { api } from '../api/client'
import { useSession } from '../api/session'
import { AGENT_CAP_FREE, AGENT_CAP_PLUS, AGENT_READY, FEE_SPLIT, FREE_AI_MSGS_PER_DAY_FALLBACK, PLUS_PRICE_FALLBACK, PLUS_PRICE_YEAR_FALLBACK } from '../config'
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
import { shortAddr } from '../components/WalletProofs'

/** only perks the code really gives. agent spending perks show once AGENT_READY. */
type Perk = { icon: IconName | 'badge'; title: string; note: string; soon?: boolean }
const perks: Perk[] = [
  { icon: 'badge', title: 'the plus check', note: 'next to your name' },
  { icon: 'sparkle', title: 'assistant, no daily limit', note: `free: ${FREE_AI_MSGS_PER_DAY_FALLBACK} a day` },
  ...(AGENT_READY ? [{ icon: 'agent' as const, title: 'an agent that acts for you', note: 'only after you confirm' }] : []),
  { icon: 'calendar', title: 'buy WIF on a schedule', note: 'pause anytime' },
  ...(AGENT_READY ? [{ icon: 'power' as const, title: `${AGENT_CAP_PLUS.toLocaleString('en-US')} WIF a day for your agent`, note: `free: ${AGENT_CAP_FREE.toLocaleString('en-US')}` }] : []),
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
  priceChanged?: boolean; renewsOn?: number | null; signedOut?: boolean; wallet?: string | null
}
const DAY = 86400_000
const fmtDate = (ms?: number | null) => (ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase() : '—')

export function Plus() {
  const { plus: localPlus, toast, openSheet } = useStore()
  const { address } = useAnyAccount()
  const { me, setMe, refresh } = useSession()
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
    const sv = server.data && (server.data.state === 'active' || server.data.state === 'grace') ? server.data : null
    if (chain.live && !(sv && !chain.hasAccess)) {
      const exp = chain.expiry ? chain.expiry * 1000 : null, grace = chain.graceEndsAt ? chain.graceEndsAt * 1000 : null
      const st: PlusState = !exp ? 'none' : chain.active ? 'active' : chain.hasAccess ? 'grace' : 'expired'
      return { state: st, plan: chain.plan, price: chain.plan === 'year' ? yearPrice : monthPrice, expiresAt: exp, graceEndsAt: grace, autoRenew: chain.autoRenew, agreedPrice: chain.maxPrice || null, priceChanged: chain.priceChanged, renewsOn: chain.autoRenew && !chain.priceChanged ? exp : null }
    }
    if (server.data && server.data.state !== 'none') return server.data
    return localPlus ? { state: 'active', plan: 'month', price: monthPrice, expiresAt: Date.now() + 30 * DAY, autoRenew: false } : { state: 'none', plan: 'month', price: monthPrice }
  }, [chain, server.data, localPlus, monthPrice, yearPrice])

  const [plan, setPlan] = useState<PlusPlanId>(v.plan ?? 'month')
  const price = plan === 'year' ? yearPrice : monthPrice
  // a price of 0 onchain means "not set yet": calm "opens soon", button off. setting the price turns it on, no deploy.
  const open = plan === 'year' ? chain.yearOpen : chain.monthOpen
  const soon = !open && !chain.pricesLoading
  const [cap, setCap] = useState<number>(v.agreedPrice ?? price)
  const has = v.state === 'active' || v.state === 'grace'
  // Wifly.sol stacks: paying while active (or in grace) adds the full period onto the current end date, and the plan
  // becomes the one just paid. no proration, so the copy says exactly that.
  const [extend, setExtend] = useState(false)
  const switching = has && plan !== v.plan
  const addsLabel = plan === 'year' ? '12 months' : '30 days'
  const base = has && v.expiresAt ? v.expiresAt : Date.now()
  const newEnd = base + (plan === 'year' ? 365 : 30) * DAY
  const showPay = !has || switching || extend || v.state === 'grace'
  const shortBy = wif !== undefined && wif < price

  // auto-renew is set onchain by the wallet that holds the sub (the server tells which one after reading every wallet
  // on the account). from any other wallet it would land on a wallet with no plus, so ask to switch instead.
  const holder = (server.data?.wallet ?? null)?.toLowerCase() ?? null
  const wrongWallet = chain.live && has && !!holder && (!address || holder !== address.toLowerCase())
  const switchMsg = holder ? `switch to ${shortAddr(holder)} to manage plus` : 'switch to the wallet that paid for plus'
  const pay = async (kind: 'buy' | 'renew') => {
    if (!open) return
    // stacking only happens on the wallet that holds the sub; paying from another one would start a separate sub there
    if (has && wrongWallet) { toast('switch wallets', switchMsg); return }
    if (!chain.live) { toast('not sent', PREVIEW_NOTE); return }
    if (!chain.team || busy) return
    setBusy(kind)
    try {
      // Receipt first, then the toast and the badge stamp (refetched subStatus flips it).
      const r = await send(plans.plus(chain.team, price, plan))
      if (r.sent) {
        companion.celebrate('plus', kind === 'renew' ? 'renewed. the check stays green ✓' : undefined)
        toast(switching && plan === 'year' ? 'upgraded to yearly' : kind === 'renew' ? 'extended' : `welcome to ${name}`, `confirmed onchain. ${addsLabel} added.`)
        setExtend(false)
        // the server reads the chain itself (receipt + every wallet on the account) and turns plus on in the same reply
        try {
          const res = await api<{ me?: Parameters<typeof setMe>[0] }>('/plus/payments', { method: 'POST', json: { plan, kind, txHash: r.hash } })
          if (res.me) setMe(res.me); else refresh()
        } catch { refresh() }
        qc.invalidateQueries({ queryKey: ['plus'] }); qc.invalidateQueries({ queryKey: ['readContracts'] })
      }
      else toast(failTitle(r), r.reason)
    } finally { setBusy(null) }
  }
  const [autoUi, setAutoUi] = useState<boolean | null>(null) // what the toggle shows while a change is in flight
  const setAuto = async (on: boolean, agreed = cap) => {
    if (wrongWallet) { toast('switch wallets', switchMsg); return }
    setAutoUi(on); setBusy('auto')
    try {
      if (chain.live && chain.team) {
        const r = await send(plans.plusAutoRenew(chain.team, plan, on ? agreed : 0))
        if (!r.sent) { setAutoUi(null); toast(failTitle(r), r.reason); return }
        // the chain has it now; the server reads it back (autoRenewOf on the holder wallet) instead of being told
        if (me) await api('/plus/sync', { method: 'POST' }).catch(() => undefined)
        qc.invalidateQueries({ queryKey: ['readContracts'] })
      } else if (me) await api('/plus/auto-renew', { method: 'POST', json: { on, agreedPrice: agreed, plan } })
      await qc.invalidateQueries({ queryKey: ['plus'] })
      toast(on ? `auto-renew on, up to ${agreed.toLocaleString()} WIF` : 'auto-renew off', chain.live ? 'saved onchain' : PREVIEW_NOTE)
    } catch (e) { toast('couldn’t change auto-renew', (e as Error).message) } finally { setAutoUi(null); setBusy(null) }
  }
  const getWif = () => { const n = plusTopUp(price); openSheet({ type: 'swap', wifOut: n, reason: `get ${n.toLocaleString()} WIF for ${name} (${price.toLocaleString()} + a small buffer)` }) }


  const needsApprove = useNeedsApprove(price)
  const headline = v.state === 'expired' ? 'your check is paused.' : v.state === 'grace' ? 'renew to keep your check.' : v.state === 'active' ? 'you’re on plus.' : (AGENT_READY ? 'the check, an assistant without limits, and an agent that does things.' : 'the check, an assistant without limits, and scheduled buys.')
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
        <h2 className="plusx-hero__title">{headline}<InfoTip label="about wifly plus">plus adds the check mark next to your name. only plus members get it.</InfoTip></h2>
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
          {open ? <div className="plusx-price">
            <PriceTag value={price} size={32} />
            <span className="plusx-price__per">{plan === 'year' ? 'per year' : 'per month'}</span>
          </div> : <div className="plusx-price plusx-price--soon" data-testid="plus-soon">
            <b>{chain.pricesLoading ? 'checking the price…' : `${plan === 'year' ? 'yearly ' : ''}plus opens soon`}</b>
            {soon && <span className="small muted">the price isn’t set yet. this turns on by itself once it is.</span>}
          </div>}
          {showPay ? <button className="btn btn--lg btn--dark btn--block" data-testid="plus-pay" disabled={!open || isTeam || !!busy} onClick={() => pay(has ? 'renew' : 'buy')}>
            {!open ? (chain.pricesLoading ? 'loading…' : 'opens soon') : busy === 'buy' || busy === 'renew' ? 'waiting for confirmation…'
              : switching ? (plan === 'year' ? `upgrade to yearly · ${price.toLocaleString()} WIF` : `switch to monthly · ${price.toLocaleString()} WIF`)
              : v.state === 'grace' ? `renew for ${price.toLocaleString()} WIF`
              : extend ? `extend ${addsLabel} · ${price.toLocaleString()} WIF`
              : v.state === 'expired' ? `renew for ${price.toLocaleString()} WIF` : `get plus for ${price.toLocaleString()} WIF`}
          </button> : <div className="plusx-on" data-testid="plus-on"><Icon name="check" size={16} /> <span>you’re covered until <b>{fmtDate(v.expiresAt)}</b></span>
            {open && <button className="plusx-link" data-testid="plus-extend" onClick={() => setExtend(true)}>extend</button>}</div>}
          {has && (switching || extend || v.state === 'grace') && open && <p className="small muted plusx-note plusx-stack" data-testid="plus-stack-note">
            adds {addsLabel} from {fmtDate(base)} · new end <b>{fmtDate(newEnd)}</b>. no proration: every day you paid for stays.
            {extend && !switching && <> <button className="plusx-link" onClick={() => setExtend(false)}>cancel</button></>}</p>}
          <div className="plusx-wallet">
            <span className="small muted"><Token size={16} /> {wif === undefined ? 'connect a wallet to see your WIF' : <>you have <b className="num">{Math.floor(wif).toLocaleString()} WIF</b></>}</span>
            {open && (shortBy || wif === undefined) && <button className="btn btn--ghost btn--sm" onClick={getWif}>get WIF</button>}
          </div>
          {isTeam && <p className="small muted plusx-note"><Icon name="shield" size={14} /> this is the team wallet. it can’t subscribe to itself.</p>}
        </div>
      </section>

      {has || v.state === 'expired' ? (
        <section className="card plus-auto">
          <div className="card__head"><span className="eyebrow">auto-renew<InfoTip label="about auto-renew">renews only at or below your cap. if the price goes up, it asks first.</InfoTip></span>
            <label className="tgl"><input type="checkbox" data-testid="plus-auto" checked={autoUi ?? !!v.autoRenew} disabled={!!busy || wrongWallet} onChange={e => setAuto(e.target.checked)} aria-label="auto-renew" /><span /></label>
          </div>
          {wrongWallet && <p className="small plusx-switch" data-testid="plus-switch"><Icon name="shield" size={14} /> {switchMsg}. auto-renew lives on the wallet that paid.</p>}
          <label className="field"><span className="field__label">max price per renewal</span>
            <span className="field__input"><input inputMode="decimal" value={cap || ''} onChange={e => setCap(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} /><span className="muted">WIF</span></span>
          </label>
          {cap < price && <p className="error small">your cap is below the current {plan === 'year' ? 'yearly' : 'monthly'} price ({price.toLocaleString()} WIF), so it would never renew.</p>}
          <div className="plus-auto__row">
            <PriceTag value={cap} size={16} />
            <button className="btn btn--dark btn--sm" disabled={!!busy || cap < price || wrongWallet} onClick={() => setAuto(true)}>{v.autoRenew ? 'update cap' : 'turn on auto-renew'}</button>
          </div>
        </section>
      ) : null}

      <h3 className="plusx-h">what you get</h3>
      <ul className="plusx-perks plusx-perks--rows" data-testid="plus-perks">
        {perks.map(p => (
          <li key={p.title} className={`plusx-row${p.soon ? ' is-soon' : ''}`}>
            <span className="plusx-row__icon">{p.icon === 'badge' ? <PlusMark size={16} /> : <Icon name={p.icon} size={16} />}</span>
            <span className="plusx-row__text"><b>{p.title}</b><span>{p.note}</span></span>
            <span className="plusx-row__end">{p.soon ? <span className="plusx-soon">soon</span> : has ? <Icon name="check" size={14} /> : null}</span>
          </li>
        ))}
      </ul>

      {open && <>
      <h3 className="plusx-h">where your WIF goes<InfoTip label="about plus payments">paid to the wifly team. the {FEE_PERCENT_LABEL} fee: {FEE_SPLIT.pot}% weekly pot, {FEE_SPLIT.burn}% burned.</InfoTip></h3>
      <section className="card plusx-card">
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
      </>}

      <h3 className="plusx-h">questions</h3>
      <div className="plusx-faq">
        {faq.map(([q, a]) => <details key={q}><summary>{q}<Icon name="chevron" size={14} /></summary><p className="small muted">{a}</p></details>)}
      </div>
    </div>
  )
}
