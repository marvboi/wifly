import { FEE_PERCENT_LABEL, shares, splitLabel, type SplitKind } from '../lib/fees'
import { useQuoteFee, useQuoteSplit } from '../lib/wifly'
import { Icon } from './Icon'

const f = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 })

const PARTS = [
  { k: 'treasury', icon: 'vault', label: 'treasury' },
  { k: 'pot', icon: 'pot', label: 'weekly community pot' },
  { k: 'burn', icon: 'flame', label: 'burned' },
] as const

/** Where a fee goes. Every fee: 90% weekly community pot, 10% burned (FEE_SPLIT). .wif claims ('claim'): 50% treasury,
 *  50% pot (CLAIM_SPLIT). Bar + legend, zero shares hidden. Amounts come from Wifly.quoteSplit when the contract is set. */
export function FeeParts({ fee, showBar = true, kind = 'fee' }: { fee: number; showBar?: boolean; kind?: SplitKind }) {
  const p = useQuoteSplit(fee, kind)
  const sh = shares(kind)
  const parts = PARTS.filter(x => sh[x.k] > 0)
  return (
    <>
      {showBar && (
        <div className="fee__bar" aria-hidden="true">
          {parts.map(x => <span key={x.k} className={`fee__${x.k}`} style={{ flex: sh[x.k] }} />)}
        </div>
      )}
      <div className="fee__legend" title={`${kind === 'claim' ? 'name claims' : 'every fee'}: ${splitLabel(kind)}`}>
        {parts.map(x => <span key={x.k}><Icon name={x.icon} size={14} /> {sh[x.k]}% {x.label} <b className="num">{f(p[x.k])}</b></span>)}
      </div>
    </>
  )
}

/** The one fee rule, shown wherever money moves. Fee and net come from Wifly.quoteFee when the contract is set. */
export function FeeSplit({ amount, recipientLabel = 'creator receives' }: { amount: number; recipientLabel?: string }) {
  const s = useQuoteFee(amount)
  return (
    <div className="fee">
      <div className="fee__rows">
        <div className="fee__row"><span>{recipientLabel}</span><span className="num strong">{f(s.receives)} WIF</span></div>
        <div className="fee__row"><span>fee · {FEE_PERCENT_LABEL}</span><span className="num">{f(s.fee)} WIF</span></div>
      </div>
      <FeeParts fee={s.fee} />
    </div>
  )
}
