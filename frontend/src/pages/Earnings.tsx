import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useSession } from '../api/session'
import { PageHead } from '../components/Shell'
import { Amount, Token } from '../components/Bits'
import { FLAT_FEE_SPLIT } from '../config'
import { useStore } from '../state/store'

type Earnings = {
  live: boolean
  withdrawableWif: number
  split: typeof FLAT_FEE_SPLIT
  paymentsLive: boolean
  sources: { label: string; note: string }[]
  payouts: { label: string; note: string }[]
}

export function Earnings() {
  const { me } = useSession()
  const { openSheet } = useStore()
  const q = useQuery({
    queryKey: ['earnings', me?.handle],
    queryFn: () => api<Earnings>('/earnings'),
    enabled: !!me,
  })
  const d = q.data
  return (
    <>
      <PageHead title="creator earnings" back sub="what you earned on wifly" />
      {!me ? (
        <div className="empty empty--card">
          <p className="strong">sign in to see earnings</p>
          <p className="muted small">tips, subscriptions and promotion bids credit your onchain balance.</p>
          <button className="btn btn--dark btn--sm" onClick={() => openSheet({ type: 'signin' })}>sign in</button>
        </div>
      ) : q.isLoading ? <p className="muted center">loading…</p> : (
        <div className="stack gap-lg">
          <section className="card card--pad">
            <p className="muted small">withdrawable now</p>
            <p className="hero-num"><Amount value={d?.withdrawableWif ?? 0} size={32} /></p>
            {!d?.live && <p className="muted small">preview: the wifly contract is not linked in this build yet.</p>}
          </section>
          <section className="card card--pad">
            <h3 className="strong small">platform fee split (flat)</h3>
            <ul className="fee-rows plain">
              <li><span>community pot</span><span className="num">{FLAT_FEE_SPLIT.pot}%</span></li>
              <li><span>burned</span><span className="num">{FLAT_FEE_SPLIT.burn}%</span></li>
              <li><span>treasury</span><span className="num">{FLAT_FEE_SPLIT.treasury}%</span></li>
            </ul>
            <p className="muted small">name claims keep their own 50/50 treasury and pot split.</p>
          </section>
          <section className="card card--pad">
            <h3 className="strong small">by source</h3>
            <ul className="plain stack gap-sm">
              {(d?.sources ?? []).map(s => (
                <li key={s.label}><span className="strong">{s.label}</span><span className="muted small block">{s.note}</span></li>
              ))}
            </ul>
          </section>
          <section className="card card--pad">
            <h3 className="strong small">payouts</h3>
            <ul className="plain stack gap-sm">
              {(d?.payouts ?? []).map(p => (
                <li key={p.label}><span className="strong">{p.label}</span><span className="muted small block">{p.note}</span></li>
              ))}
            </ul>
            <p className="muted small"><Token size={16} /> withdraw from the wifly contract from any wallet that holds the balance.</p>
          </section>
          {d?.paymentsLive && <p className="muted small center">plus, names and boosts can also settle in usdg or eth through the payments router.</p>}
        </div>
      )}
    </>
  )
}