import { Icon } from './Icon'
import { useTheme, type ThemePref } from '../lib/theme'

const OPTS: { v: ThemePref; icon: 'sun' | 'monitor' | 'moon'; label: string }[] = [
  { v: 'light', icon: 'sun', label: 'light' },
  { v: 'system', icon: 'monitor', label: 'auto' },
  { v: 'dark', icon: 'moon', label: 'dark' },
]

/** Light / auto / dark. A sliding pill marks the choice. `labeled` shows the words (settings). */
export function ThemeToggle({ className = '', labeled = false }: { className?: string; labeled?: boolean }) {
  const { pref, setPref } = useTheme()
  const i = OPTS.findIndex(o => o.v === pref)
  return (
    <div className={`tt${labeled ? ' tt--labeled' : ''} ${className}`} role="radiogroup" aria-label="theme" style={{ ['--i' as string]: i }} data-testid={labeled ? 'theme-switch' : undefined}>
      <span className="tt__pill" aria-hidden="true" />
      {OPTS.map(o => (
        <button key={o.v} type="button" role="radio" aria-checked={pref === o.v} aria-label={labeled ? undefined : `${o.label} theme`} title={labeled ? undefined : o.label}
          className={`tt__b${pref === o.v ? ' is-on' : ''}`} data-theme-opt={o.label}
          onClick={e => {
            // Landing / docs (icon-only): circular wipe from the clicked button. Settings (labeled): soft fade.
            if (labeled) { setPref(o.v); return }
            const r = e.currentTarget.getBoundingClientRect()
            setPref(o.v, { x: r.left + r.width / 2, y: r.top + r.height / 2 })
          }}>
          <Icon name={o.icon} size={15} />
          {labeled && <span className="tt__l">{o.label}</span>}
        </button>
      ))}
    </div>
  )
}

/** More sheet: one tap between light and dark. On auto it shows what the device picked; a tap pins the other one. Soft fade (no origin). */
export function ThemeQuickRow() {
  const { pref, theme, setPref } = useTheme()
  const dark = theme === 'dark'
  const hint = pref === 'system' ? `auto · following your device` : dark ? 'on' : 'off'
  return (
    <button type="button" role="switch" aria-checked={dark} className="moresheet__row moresheet__row--theme" data-testid="more-theme"
      onClick={() => setPref(dark ? 'light' : 'dark')}>
      <span className="moresheet__disc moresheet__disc--theme"><Icon name={dark ? 'moon' : 'sun'} size={22} /></span>
      <span className="moresheet__text">
        <span className="moresheet__title"><b>dark mode</b></span>
        <span className="moresheet__hint">{hint}</span>
      </span>
      <span className={`switch switch--static${dark ? ' is-on' : ''}`} aria-hidden="true"><span className="switch__knob" /></span>
    </button>
  )
}
