import { Token } from './Bits'
import { PAY_TOKEN_META, type PayRails, type PayToken, altPayEnabled } from '../lib/payToken'

export function PayTokenPicker({ value, onChange, rails, className }: {
  value: PayToken
  onChange: (t: PayToken) => void
  rails: PayRails
  className?: string
}) {
  const alt = altPayEnabled(rails)
  const items: PayToken[] = ['wif', 'usdg', 'eth']
  return (
    <div className={['seg pay-token-seg', className].filter(Boolean).join(' ')} role="radiogroup" aria-label="pay with">
      {items.map(t => {
        const on = t === 'wif' || alt
        const meta = PAY_TOKEN_META[t]
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={value === t}
            disabled={!on}
            className={[value === t ? 'is-on' : '', !on ? 'is-soon' : ''].filter(Boolean).join(' ')}
            onClick={() => on && onChange(t)}
          >
            <span className="pay-token-seg__icon" aria-hidden="true">
              {t === 'wif' ? <Token size={16} /> : meta.logo ? <img src={meta.logo} alt="" width={16} height={16} className="pay-token-seg__img" loading="lazy" /> : <span className="pay-token-seg__dot" />}
            </span>
            <span>{meta.label}</span>
            {!on && <span className="pay-token-seg__soon">soon</span>}
          </button>
        )
      })}
    </div>
  )
}