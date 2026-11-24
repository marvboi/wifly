import { FEE_PERCENT_LABEL, shares, splitLabel, type SplitKind } from '../lib/fees'
import { useQuoteFee, useQuotePlusFee, useQuoteSplit } from '../lib/wifly'
import { Icon } from './Icon'
import { InfoTip } from './InfoTip'

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

/** The one fee rule, shown wherever money moves. Fee and net come from Wifly.quoteFee / quotePlusFee when live. */
export function FeeSplit({ amount, recipientLabel = 'creator receives', kind = 'fee' as SplitKind }: { amount: number; recipientLabel?: string; kind?: SplitKind }) {
  const fee = useQuoteFee(amount)
  const plus = useQuotePlusFee(amount)
  const s = kind === 'plus' ? plus : fee
  const tip = kind === 'plus'
    ? `the full ${FEE_PERCENT_LABEL} is burned. nothing goes to the weekly pot or treasury.`
    : `${splitLabel('fee')}. ${f(s.pot)} wif to the weekly pot, ${f(s.burn)} wif burned.`
  const feeLabel = kind === 'plus' ? 'burn' : 'fee'
  return (
    <div className="fee">
      <div className="fee__rows">
        <div className="fee__row"><span>{recipientLabel}</span><span className="num strong">{f(s.receives)} wif</span></div>
        <div className="fee__row"><span>{feeLabel} · {FEE_PERCENT_LABEL}<InfoTip label="where the fee goes">{tip}</InfoTip></span><span className="num">{f(s.fee)} wif</span></div>
      </div>
    </div>
  )
}
