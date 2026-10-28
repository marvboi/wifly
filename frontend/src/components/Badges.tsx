/** Soulbound burn badges (WiflyBadges): medal art, the profile shelf and the detail sheet. No glows. */
import { InfoTip } from './InfoTip'
import { useId, useMemo } from 'react'
import { medalSvg } from '../lib/medal'
import { BADGE_LEVELS } from '../config'
import { useBadges } from '../sheets/NewSheets'
import { useStore } from '../state/store'
import { WifUsd } from './Bits'

/** A burn-badge medal. Crisp SVG from lib/medal (same art as public/badges/<id>.svg); gentle tilt + shimmer on hover. */
export function BadgeArt({ id, size = 48, earned = true, tilt = true }: { id: string; size?: number; earned?: boolean; tilt?: boolean }) {
  const uid = useId()
  const t = BADGE_LEVELS.find(l => l.id === id) ?? BADGE_LEVELS[0]
  const html = useMemo(() => medalSvg(t, { earned, uid: `${id}${uid}` }), [t, earned, uid, id])
  return <span className={`medal ${earned ? 'is-earned' : 'is-locked'} ${tilt ? 'medal--tilt' : ''}`} style={{ width: size, height: size }}
    role="img" aria-label={`${t.name} badge, ${t.min.toLocaleString('en-US')} WIF burned${earned ? '' : ', not earned yet'}`}
    dangerouslySetInnerHTML={{ __html: html }} />
}

/** Profile badge shelf: all four levels, earned ones in colour, plus progress to the next. */
export function BadgeShelf({ handle, mine }: { handle: string; mine?: boolean }) {
  const { openSheet } = useStore()
  const b = useBadges(handle).data
  const burned = b?.burned ?? 0
  const next = BADGE_LEVELS.find(l => l.min > burned)
  const prev = [...BADGE_LEVELS].reverse().find(l => l.min <= burned)?.min ?? 0
  const pct = next ? Math.min(100, ((burned - prev) / (next.min - prev)) * 100) : 100
  if (!b && !mine) return null
  return (
    <section className="badgeshelf" aria-label="burn badges">
      <div className="badgeshelf__head">
        <div><b>badges</b><InfoTip label="about burn badges">soulbound badges for WIF you burn: 1k, 10k, 100k, 1m.</InfoTip> <span className="muted small">· {burned.toLocaleString()} WIF burned <WifUsd wif={burned} /></span></div>
        {mine && <button className="btn btn--ghost btn--sm" onClick={() => openSheet({ type: 'burn' })}>burn to earn</button>}
      </div>
      <div className="badgeshelf__row">
        {BADGE_LEVELS.map(l => {
          const earned = burned >= l.min
          return (
            <button type="button" key={l.id} className={`badgeshelf__item ${earned ? 'is-earned' : ''}`} onClick={() => openSheet({ type: 'badge', id: l.id, handle })}>
              <BadgeArt id={l.id} size={60} earned={earned} />
              <span className="small strong">{l.name}</span>
              <span className="tiny muted num">{l.min >= 1e6 ? `${l.min / 1e6}M` : `${l.min / 1e3}k`} burned</span>
            </button>
          )
        })}
      </div>
      {next && <div className="badgeshelf__next">
        <div className="bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
        <span className="tiny muted">{(next.min - burned).toLocaleString()} WIF to {next.name}{b?.pending ? ` · ${b.pending.toLocaleString()} pending` : ''}</span>
      </div>}
    </section>
  )
}
