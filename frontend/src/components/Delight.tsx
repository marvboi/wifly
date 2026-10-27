/**
 * Small, shared moments of character (CSS + SVG + rAF only, no extra libs). Every piece respects
 * prefers-reduced-motion: CSS animations are switched off in app.css and motion/react follows MotionConfig.
 *  - Blank: an empty state with the live face (no posts, no results, nothing saved, 404).
 *  - Tick: a number that rolls to its new value (vote counts, tips, countdown digits, prices).
 *  - SkelRows: calm placeholder rows instead of a spinner or "loading…".
 *  - Reveal: fades a section up the first time it scrolls into view.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { Mascot, type Mood } from './Mascot'

export function Blank({ title, body, action, mood = 'calm', size = 72, className = '' }: { title: string; body?: ReactNode; action?: ReactNode; mood?: Mood; size?: number; className?: string }) {
  return (
    <motion.div className={`blank ${className}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 220, damping: 26 }}>
      <motion.span className="blank__face" initial={{ scale: 0.6, rotate: -10 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 14, delay: 0.05 }}>
        <Mascot size={size} mood={mood} />
      </motion.span>
      <p className="blank__title">{title}</p>
      {body && <p className="blank__body">{body}</p>}
      {action}
    </motion.div>
  )
}

/** A number that rolls up (or down) to its new value. Width follows the wider of the two, so nothing jumps. */
export function Tick({ value, format, className = '' }: { value: number; format?: (n: number) => string; className?: string }) {
  const f = format ?? ((n: number) => n.toLocaleString('en-US'))
  const prev = useRef(value)
  const [s, setS] = useState<{ cur: number; old: number | null; up: boolean; k: number }>({ cur: value, old: null, up: true, k: 0 })
  useEffect(() => {
    if (value === prev.current) return
    const old = prev.current; prev.current = value
    setS(p => ({ cur: value, old, up: value > old, k: p.k + 1 }))
  }, [value])
  const dir = s.up ? 'is-up' : 'is-down'
  return (
    <span className={`tick ${className}`}>
      <span key={s.k} className={`tick__cur ${s.old !== null ? dir : ''}`}>{f(s.cur)}</span>
      {s.old !== null && <span key={`o${s.k}`} className={`tick__old ${dir}`} aria-hidden="true">{f(s.old)}</span>}
    </span>
  )
}

export function SkelRows({ n = 3, kind = 'row' }: { n?: number; kind?: 'row' | 'post' }) {
  return (
    <div className={`skelrows skelrows--${kind}`} aria-busy="true" aria-label="loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skelrow" style={{ animationDelay: `${i * 90}ms` }}>
          <span className="skel skel--circle" />
          <span className="skelrow__lines"><span className="skel skel--line" style={{ width: `${46 + ((i * 17) % 30)}%` }} /><span className="skel skel--line skel--thin" style={{ width: `${70 + ((i * 11) % 22)}%` }} />{kind === 'post' && <span className="skel skel--block" />}</span>
        </div>
      ))}
    </div>
  )
}

export function Reveal({ children, className, delay = 0, as = 'div' }: { children: ReactNode; className?: string; delay?: number; as?: 'div' | 'section' }) {
  const C = as === 'section' ? motion.section : motion.div
  return (
    <C className={className} initial={{ opacity: 0, y: 28 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ type: 'spring', stiffness: 120, damping: 22, delay }}>
      {children}
    </C>
  )
}

/** A post-shaped placeholder: avatar, name and handle, 2-3 text lines, sometimes media, the action row. */
export function PostSkel({ n = 3, media = true }: { n?: number; media?: boolean }) {
  return (
    <div className="postskels" aria-busy="true" aria-label="loading drops">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="drop postskel" aria-hidden="true" style={{ animationDelay: `${i * 80}ms` }}>
          <div className="postskel__head">
            <span className="skel skel--circle postskel__av" />
            <span className="postskel__who"><span className="skel skel--line" style={{ width: `${28 + ((i * 13) % 18)}%` }} /><span className="skel skel--line skel--thin" style={{ width: `${18 + ((i * 7) % 10)}%` }} /></span>
          </div>
          <div className="postskel__body">
            <span className="skel skel--line" style={{ width: '94%' }} />
            <span className="skel skel--line" style={{ width: `${62 + ((i * 19) % 30)}%` }} />
            {i % 2 === 1 && <span className="skel skel--line" style={{ width: '38%' }} />}
            {media && i % 3 === 0 && <span className="skel postskel__media" />}
          </div>
          <div className="postskel__actions">{[0, 1, 2, 3, 4].map(k => <span key={k} className="skel postskel__act" />)}</div>
        </div>
      ))}
    </div>
  )
}

/** Profile header placeholder in the same shape as .pcard. */
export function ProfileSkel() {
  return (
    <section className="pcard profskel" aria-busy="true" aria-label="loading profile">
      <div className="pcard__banner"><span className="skel profskel__banner" /></div>
      <div className="pcard__body">
        <div className="pcard__id">
          <span className="skel skel--circle profskel__av" />
          <span className="postskel__who" style={{ flex: 1 }}><span className="skel skel--line" style={{ width: '46%', height: 22 }} /><span className="skel skel--line skel--thin" style={{ width: '28%' }} /></span>
        </div>
        <span className="skel skel--line" style={{ width: '82%' }} />
        <span className="skel skel--line skel--thin" style={{ width: '54%' }} />
        <div className="profskel__stats">{[0, 1, 2].map(k => <span key={k} className="skel profskel__stat" />)}</div>
      </div>
    </section>
  )
}

/** Rows shaped like the .wif names list (art thumbnail, name, price). */
export function NameSkel({ n = 4 }: { n?: number }) {
  return (
    <ul className="names-list nameskels" aria-busy="true" aria-label="loading names">
      {Array.from({ length: n }, (_, i) => (
        <li key={i} className="names-row nameskel" aria-hidden="true">
          <span className="skel nameskel__art" />
          <span className="skel skel--line" style={{ width: `${24 + ((i * 11) % 20)}%` }} />
          <span className="skel skel--line nameskel__price" />
        </li>
      ))}
    </ul>
  )
}

/** One .wif name page loading: the square card and two lines under it. */
export function NameCardSkel() {
  return (
    <div className="namecardskel" aria-busy="true" aria-label="loading name">
      <span className="skel namecardskel__art" />
      <span className="skel skel--line" style={{ width: '48%' }} />
      <span className="skel skel--line skel--thin" style={{ width: '72%' }} />
    </div>
  )
}
