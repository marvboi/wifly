import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Mascot } from './Mascot'

/**
 * A WIF Name as people see it: "marv.wif" plus a small ink check when it's the holder's verified primary
 * (reverseName(address) returned it). Links to the public name page.
 */
export function WifName({ label, verified = true, link = true, size = 'md' }: { label: string; verified?: boolean; link?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  const body = (
    <>
      <span className="wifname__label">{label}</span><span className="wifname__tld">.wif</span>
      {verified && <svg className="wifname__check" viewBox="0 0 16 16" width="14" height="14" aria-label="verified primary name"><circle cx="8" cy="8" r="8" /><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </>
  )
  return link ? <Link to={`/n/${label}`} className={`wifname wifname--${size}`}>{body}</Link> : <span className={`wifname wifname--${size}`}>{body}</span>
}

/**
 * The animated name card: an ink card with the face, the name typing in, a shimmerless sheen sweep and the fee.
 * `state` drives the face and the stamp ("yours" plays the claim stamp).
 */
const NAME_RE = /^[a-z0-9_]{3,20}$/
/** URL of a name's card art, produced by the onchain WiflyNameRenderer (backend runs the same bytecode until it is deployed). */
export const nameArtUrl = (label: string, theme?: number) => `/api/names/art/${encodeURIComponent(label)}.svg${theme === undefined ? '' : `?t=${theme}`}`

/** Card themes (WiflyNames.setTheme): 0 = default (rare green, others white), 1 = white, 2 = green. */
export type CardTheme = 0 | 1 | 2
export const isRareName = (label: string) => NAME_RE.test(label) && label.length <= 4
export const defaultThemeOf = (label: string): 1 | 2 => (isRareName(label) ? 2 : 1)

/** White / Green picker with live (animated, onchain-rendered) thumbnails. `value` is the look shown (1 or 2). */
export function ThemePicker({ label, value, onChange, disabled }: { label: string; value: 1 | 2; onChange: (t: 1 | 2) => void; disabled?: boolean }) {
  const art = NAME_RE.test(label) ? label : 'yourname'
  const def = defaultThemeOf(art)
  return (
    <div className="themepick" role="radiogroup" aria-label="card look">
      {([1, 2] as const).map(t => (
        <button key={t} type="button" role="radio" aria-checked={value === t} disabled={disabled}
          className={`themepick__opt ${value === t ? 'is-on' : ''}`} onClick={() => onChange(t)}>
          <img src={nameArtUrl(art, t)} alt="" loading="lazy" />
          <span className="themepick__label">{t === 1 ? 'White' : 'Green'}{def === t && <span className="tiny muted"> · default</span>}</span>
        </button>
      ))}
    </div>
  )
}

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v)
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms])
  return d
}

/** The onchain name card (WiflyNameRenderer.svg) plus a status strip. Same art the NFT shows in any wallet. */
export function NameCard({ label, state = 'idle', fee, owner, size = 'md', theme }: { label: string; state?: 'idle' | 'available' | 'taken' | 'reserved' | 'yours'; fee?: number; owner?: string | null; size?: 'sm' | 'md' | 'lg'; theme?: number }) {
  const reduced = useReducedMotion()
  const typed = useDebounced(label, 320)
  const art = NAME_RE.test(typed) ? typed : 'yourname'
  const [loaded, setLoaded] = useState<string | null>(null)
  const src = nameArtUrl(art, theme)
  return (
    <div className={`namecard namecard--art namecard--${size} is-${state}`}>
      <div className="namecard__art">
        {loaded !== art && <span className="namecard__ph" aria-hidden="true"><Mascot size={56} tile={false} mood="think" /></span>}
        <AnimatePresence initial={false}>
          <motion.img key={src} src={src} alt={`${art}.wif name card, rendered onchain`} onLoad={() => setLoaded(art)}
            initial={reduced ? false : { opacity: 0, scale: 0.985 }} animate={{ opacity: loaded === art ? (art === 'yourname' && !label ? 0.45 : 1) : 0, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.28 }} />
        </AnimatePresence>
        <AnimatePresence>{label && label !== typed && <motion.span key="live" className="namecard__live" aria-hidden="true"
          style={{ ['--s' as string]: Math.max(0.55, Math.min(1, 11 / (label.length + 4))) }}
          initial={reduced ? false : { opacity: 0, y: 6, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: -4, x: '-50%' }} transition={{ duration: 0.16 }}>{label}<i>.wif</i></motion.span>}</AnimatePresence>
        {state === 'yours' && <motion.span className="namecard__stamp" initial={{ scale: 2.2, opacity: 0, rotate: -18 }} animate={{ scale: 1, opacity: 1, rotate: -8 }} transition={{ type: 'spring', stiffness: 420, damping: 18, delay: 0.15 }}>claimed</motion.span>}
      </div>
      <div className="namecard__foot">
        <span className="namecard__state">{state === 'yours' ? 'yours' : state === 'available' ? 'available' : state === 'taken' ? 'taken by another wallet' : state === 'reserved' ? 'reserved' : 'type a name'}</span>
        {fee !== undefined && state !== 'yours' && <span className="num">{fee.toLocaleString('en-US')} WIF claim fee</span>}
        {owner && state === 'yours' && !/^0x0{4}/.test(owner) && <span className="mono">{owner}</span>}
      </div>
    </div>
  )
}
