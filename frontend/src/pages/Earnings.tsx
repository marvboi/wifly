import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { InfoTip } from '../components/InfoTip'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { useSession } from '../api/session'
import { PageHead } from '../components/Shell'
import { Amount, Token } from '../components/Bits'
import { Icon } from '../components/Icon'
import { FLAT_FEE_SPLIT } from '../config'
import { useStore } from '../state/store'

type Earnings = {
  live: boolean
  withdrawableWif: number
  split: typeof FLAT_FEE_SPLIT
  paymentsLive: boolean
  sources: { label: string; note: string; valueWif?: number }[]
  payouts: { label: string; note: string; valueWif?: number }[]
}

/** Local screenshot / demo only (not from the server). */
const DEMO_EARNINGS: Earnings = {
  live: true,
  withdrawableWif: 12_450.25,
  split: FLAT_FEE_SPLIT,
  paymentsLive: true,
  sources: [
    { label: 'tips', valueWif: 8_420.5, note: 'local preview totals' },
    { label: 'subscriptions', valueWif: 3_250, note: 'local preview totals' },
    { label: 'top spot', valueWif: 779.75, note: 'local preview totals' },
  ],
  payouts: [{ label: 'withdraw', valueWif: 12_450.25, note: 'matches withdrawable now' }],
}

function fmtWif(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} wif`
}

function KvRow({ label, value, note, hideNote }: { label: string; value?: string; note?: string; hideNote?: boolean }) {
  return (
    <li className="earnings-kv__row">
      <div className="earnings-kv__left">
        <span className="earnings-kv__label">{label}</span>
        {note && !hideNote ? <span className="earnings-kv__note muted small">{note}</span> : null}
        {note && hideNote ? <span className="earnings-kv__note muted small sr-only">{note}</span> : null}
      </div>
      {value !== undefined ? <span className="earnings-kv__value num tabular-nums">{value}</span> : null}
    </li>
  )
}

export function Earnings() {
  const { me } = useSession()
  const { openSheet } = useStore()
  const [sp] = useSearchParams()
  const demoLocal = sp.get('demo') === 'earnings'
  const q = useQuery({
    queryKey: ['earnings', me?.handle],
    queryFn: () => api<Earnings>('/earnings'),
    enabled: !!me && !demoLocal,
  })
  const d = demoLocal ? DEMO_EARNINGS : q.data
  const loading = !demoLocal && q.isLoading
  const [sourceDetails, setSourceDetails] = useState(false)
  return (
    <>
      <PageHead title="creator earnings" back sub="what you earned on wifly" />
      {demoLocal && <p className="banner banner--demo small" role="status">local preview data for screenshots only</p>}
      {!me && !demoLocal ? (
        <div className="empty empty--card">
          <p className="strong">sign in to see earnings</p>
          <p className="muted small">tips, subscriptions and promotion bids credit your onchain balance.</p>
          <button className="btn btn--dark btn--sm" onClick={() => openSheet({ type: 'signin' })}>sign in</button>
        </div>
      ) : loading ? <p className="muted center">loading…</p> : (
        <div className="stack gap-lg earnings-page">
          <section className="card card--pad earnings-hero">
            <p className="muted small">withdrawable now</p>
            <p className="hero-num"><Amount value={d?.withdrawableWif ?? 0} size={32} /></p>
            {!d?.live && !demoLocal && <p className="muted small">preview: the wifly contract is not linked in this build yet.</p>}
            <details className="earnings-fee-fold">
              <summary className="earnings-fee-fold__sum">fee split details <Icon name="chevron" size={14} /></summary>
              <h3 className="strong small earnings-card__title">platform fee split (flat)</h3>
              <ul className="earnings-kv plain">
                <KvRow label="community pot" value={`${FLAT_FEE_SPLIT.pot}%`} />
                <KvRow label="burned" value={`${FLAT_FEE_SPLIT.burn}%`} />
                <KvRow label="treasury" value={`${FLAT_FEE_SPLIT.treasury}%`} />
              </ul>
              <p className="muted small earnings-card__foot">name claims keep their own 50/50 treasury and pot split.</p>
            </details>
          </section>
          <section className="card card--pad earnings-card">
            <div className="earnings-card__head">
              <h3 className="strong small earnings-card__title">by source</h3>
              <button type="button" className="linkbtn small" aria-expanded={sourceDetails} onClick={() => setSourceDetails(v => !v)}>details</button>
            </div>
            <ul className="earnings-kv plain">
              {(d?.sources ?? []).map(s => (
                <KvRow key={s.label} label={s.label} value={s.valueWif !== undefined ? fmtWif(s.valueWif) : undefined} note={s.note} hideNote={!sourceDetails} />
              ))}
            </ul>
          </section>
          <section className="card card--pad earnings-card">
            <div className="earnings-card__head">
              <h3 className="strong small earnings-card__title">payouts</h3>
              {d?.paymentsLive ? (
                <InfoTip label="USDG or eth">plus, names and boosts can also settle in USDG or eth on wifly.</InfoTip>
              ) : null}
            </div>
            <p className="sr-only">plus, names and boosts can also settle in USDG or eth on wifly.</p>
            <ul className="earnings-kv plain">
              {(d?.payouts ?? []).map(p => (
                <KvRow key={p.label} label={p.label} value={p.valueWif !== undefined ? fmtWif(p.valueWif) : undefined} note={p.note} hideNote={!sourceDetails} />
              ))}
            </ul>
            {sourceDetails && <p className="muted small earnings-card__foot"><Token size={16} /> withdraw from the wifly contract from any wallet that holds the balance.</p>}
          </section>
        </div>
      )}
    </>
  )
}