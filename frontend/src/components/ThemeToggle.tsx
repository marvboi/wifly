import { Icon } from './Icon'
import { useTheme, type ThemePref } from '../lib/theme'

const OPTS: { v: ThemePref; icon: 'sun' | 'monitor' | 'moon'; label: string }[] = [
  { v: 'light', icon: 'sun', label: 'light' },
  { v: 'system', icon: 'monitor', label: 'system' },
  { v: 'dark', icon: 'moon', label: 'dark' },
]

/** Light / system / dark. A sliding pill marks the choice; the switch reveals from the clicked button. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { pref, setPref } = useTheme()
  const i = OPTS.findIndex(o => o.v === pref)
  return (
    <div className={`tt ${className}`} role="radiogroup" aria-label="theme" style={{ ['--i' as string]: i }}>
      <span className="tt__pill" aria-hidden="true" />
      {OPTS.map(o => (
        <button key={o.v} type="button" role="radio" aria-checked={pref === o.v} aria-label={`${o.label} theme`} title={o.label}
          className={`tt__b${pref === o.v ? ' is-on' : ''}`}
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect()
            setPref(o.v, { x: r.left + r.width / 2, y: r.top + r.height / 2 })
          }}>
          <Icon name={o.icon} size={15} />
        </button>
      ))}
    </div>
  )
}
