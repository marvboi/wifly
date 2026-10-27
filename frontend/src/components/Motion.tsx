/**
 * Shared motion pieces. Built on `motion` (framer-motion). The app root wraps everything in
 * <MotionConfig reducedMotion="user">, so transforms are skipped for people who ask for less motion;
 * the helpers here also check it for anything that animates text or numbers.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { animate, motion, useInView, useReducedMotion, type Transition } from 'motion/react'

export const spring: Transition = { type: 'spring', stiffness: 380, damping: 30, mass: 0.8 }
export const softSpring: Transition = { type: 'spring', stiffness: 170, damping: 24 }
export const bouncy: Transition = { type: 'spring', stiffness: 520, damping: 18 }

const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })

/** A number that eases to its new value whenever it changes. Writes text directly, no re-render per frame. */
export function AnimatedNumber({ value, decimals = 0, duration = 0.9, prefix = '', className, from }: {
  value: number; decimals?: number; duration?: number; prefix?: string; className?: string; from?: number
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const last = useRef(from ?? value)
  const reduced = useReducedMotion()
  const inView = useInView(ref, { once: true })
  useEffect(() => {
    const el = ref.current
    if (!el || !inView) return
    if (reduced) { el.textContent = prefix + fmt(value, decimals); last.current = value; return }
    const c = animate(last.current, value, {
      duration, ease: [0.22, 1, 0.36, 1],
      onUpdate: v => { el.textContent = prefix + fmt(v, decimals) },
    })
    last.current = value
    return () => c.stop()
  }, [value, decimals, duration, prefix, reduced, inView])
  return <span ref={ref} className={`num ${className ?? ''}`}>{prefix + fmt(from ?? value, decimals)}</span>
}

/** Odometer: every digit is a rolling column. Commas stay put. */
export function Odometer({ value, className, label }: { value: number; className?: string; label?: string }) {
  const s = fmt(Math.max(0, Math.round(value)))
  const reduced = useReducedMotion()
  return (
    <span className={`odo num ${className ?? ''}`} role="img" aria-label={label ? `${s} ${label}` : s}>
      {s.split('').map((ch, i) => {
        const key = s.length - i // keep columns stable from the right as the number grows
        if (!/\d/.test(ch)) return <span key={`c${key}`} className="odo__sep" aria-hidden="true">{ch}</span>
        const d = Number(ch)
        return (
          <span key={`d${key}`} className="odo__col" aria-hidden="true">
            <motion.span className="odo__strip" initial={false} animate={{ y: `${-d * 10}%` }}
              transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 120, damping: 20, delay: (s.length - i) * 0.03 }}>
              {'0123456789'.split('').map(n => <span key={n}>{n}</span>)}
            </motion.span>
          </span>
        )
      })}
    </span>
  )
}

/** Headline that reveals word by word. Line breaks with '\n'. */
export function WordReveal({ text, className, delay = 0, as = 'h1' }: { text: string; className?: string; delay?: number; as?: 'h1' | 'h2' }) {
  const Tag = motion[as]
  const lines = text.split('\n')
  let i = 0
  return (
    <Tag className={className} aria-label={text.replace(/\n/g, ' ')} initial="hidden" animate="show"
      variants={{ show: { transition: { staggerChildren: 0.07, delayChildren: delay } } }}>
      {lines.map((line, li) => (
        <span key={li} className="reveal__line" aria-hidden="true">
          {line.split(' ').map(w => (
            <Fragment key={i++}><span className="reveal__mask">
              <motion.span className="reveal__word"
                variants={{ hidden: { y: '110%', rotate: 4 }, show: { y: '0%', rotate: 0, transition: { type: 'spring', stiffness: 260, damping: 26 } } }}>
                {w}
              </motion.span>
            </span>{' '}</Fragment>
          ))}
        </span>
      ))}
    </Tag>
  )
}

/** Cards that spring in as they scroll into view. */
export function Rise({ children, className, delay = 0, as = 'div' }: { children: ReactNode; className?: string; delay?: number; as?: 'div' | 'li' }) {
  const Tag = motion[as]
  return (
    <Tag className={className} initial={{ opacity: 0, y: 28, scale: 0.98 }} whileInView={{ opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, margin: '0px 0px -40px 0px' }} transition={{ ...softSpring, delay }}>
      {children}
    </Tag>
  )
}

/** A little "+N" that floats up and fades. Re-mounts on each new `id`. */
export function FloatUp({ id, children, className }: { id: number | string; children: ReactNode; className?: string }) {
  return (
    <motion.span key={id} className={`floatup ${className ?? ''}`} aria-hidden="true"
      initial={{ opacity: 0, y: 6, scale: 0.9 }} animate={{ opacity: [0, 1, 1, 0], y: -34, scale: 1 }}
      transition={{ duration: 1.3, ease: [0.22, 1, 0.36, 1], times: [0, 0.15, 0.65, 1] }}>
      {children}
    </motion.span>
  )
}

/** Ticks once a second; for live countdowns. */
export function useClock(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t) }, [ms])
  return now
}

export { motion }

/** '2d 14h' / '3h 12m' → seconds. */
export function parseDur(s: string) {
  let t = 0
  for (const [, n, u] of s.matchAll(/(\d+)\s*([dhms])/g)) t += Number(n) * ({ d: 86400, h: 3600, m: 60, s: 1 } as const)[u as 'd']
  return t
}
/** Seconds → '2d 14h 03m 09s' style, dropping leading zero units. */
export function fmtDur(sec: number) {
  const s = Math.max(0, Math.floor(sec)), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return d ? `${d}d ${p(h)}h ${p(m)}m ${p(x)}s` : h ? `${h}h ${p(m)}m ${p(x)}s` : `${m}m ${p(x)}s`
}
/** Fixed at page load so sample countdowns tick down from a stable point. */
export const T0 = Date.now()
