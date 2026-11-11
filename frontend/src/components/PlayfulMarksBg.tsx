/**
 * Decorative field of official bouncing Wifly logos behind the sign-up / onboarding page.
 * Inert aside from optional hover/tap (aria-hidden). The official 4s face loop is used
 * when motion is allowed; static marks otherwise.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { MARK_CLEAR_SELECTORS, packingHits, placeSlots } from '../lib/playfulMarksClear'
import { PLAY_LERP, atRest, isHotAt, layoutCenter, lerpToward, orientationNorm, playNorm } from '../lib/playfulMarksMotion'

type Slot = { t: string; l: string; s: number; r: number; c: 0 | 1 | 2 | 3; d: number; dur: number; delay: number; group: 0 | 1 | 2 | 3 }

export const SLOTS: Slot[] = [
  { t: '2%', l: '-3%', s: 96, r: -16, c: 0, d: 0.5, dur: 22, delay: 0, group: 0 },
  { t: '1%', l: '38%', s: 68, r: 12, c: 3, d: 0.25, dur: 26, delay: 1.2, group: 1 },
  { t: '3%', l: '74%', s: 112, r: -8, c: 1, d: 0.6, dur: 24, delay: 0.6, group: 2 },
  { t: '14%', l: '12%', s: 52, r: 22, c: 2, d: 0.2, dur: 18, delay: 2.1, group: 3 },
  { t: '16%', l: '54%', s: 80, r: -24, c: 0, d: 0.45, dur: 20, delay: 3.4, group: 0 },
  { t: '17%', l: '86%', s: 48, r: 16, c: 3, d: 0.15, dur: 17, delay: 1.8, group: 1 },
  { t: '28%', l: '-5%', s: 74, r: 8, c: 1, d: 0.35, dur: 23, delay: 4.0, group: 2 },
  { t: '30%', l: '28%', s: 40, r: -30, c: 2, d: 0.12, dur: 16, delay: 0.4, group: 3 },
  { t: '26%', l: '60%', s: 92, r: 14, c: 3, d: 0.55, dur: 25, delay: 2.8, group: 1 },
  { t: '32%', l: '80%', s: 56, r: -20, c: 0, d: 0.3, dur: 19, delay: 5.2, group: 0 },
  { t: '44%', l: '5%', s: 100, r: -12, c: 3, d: 0.5, dur: 21, delay: 1.0, group: 2 },
  { t: '46%', l: '46%', s: 44, r: 26, c: 1, d: 0.18, dur: 15, delay: 3.0, group: 3 },
  { t: '40%', l: '72%', s: 64, r: -22, c: 2, d: 0.28, dur: 27, delay: 4.6, group: 1 },
  { t: '56%', l: '-2%', s: 54, r: 18, c: 0, d: 0.22, dur: 18, delay: 2.2, group: 0 },
  { t: '58%', l: '22%', s: 84, r: -6, c: 1, d: 0.4, dur: 22, delay: 0.8, group: 2 },
  { t: '60%', l: '58%', s: 42, r: 32, c: 3, d: 0.14, dur: 16, delay: 5.5, group: 3 },
  { t: '52%', l: '86%', s: 76, r: -16, c: 2, d: 0.38, dur: 20, delay: 3.6, group: 1 },
  { t: '72%', l: '4%', s: 60, r: 20, c: 2, d: 0.26, dur: 24, delay: 1.5, group: 0 },
  { t: '74%', l: '36%', s: 104, r: -20, c: 0, d: 0.58, dur: 23, delay: 4.2, group: 2 },
  { t: '70%', l: '76%', s: 50, r: 10, c: 1, d: 0.2, dur: 17, delay: 0.2, group: 3 },
  { t: '86%', l: '-4%', s: 88, r: -26, c: 3, d: 0.42, dur: 26, delay: 2.6, group: 1 },
  { t: '88%', l: '28%', s: 46, r: 24, c: 2, d: 0.16, dur: 15, delay: 3.8, group: 0 },
  { t: '90%', l: '56%', s: 70, r: -14, c: 1, d: 0.32, dur: 21, delay: 1.7, group: 2 },
  { t: '84%', l: '88%', s: 58, r: 6, c: 0, d: 0.24, dur: 19, delay: 5.0, group: 3 },
]

const COLOR = ['red', 'blue', 'green', 'yellow'] as const
const TILE =
  'M26 0 H74 C88.4 0 100 11.6 100 26 V74 C100 88.4 88.4 100 74 100 H26 C11.6 100 0 88.4 0 74 V26 C0 11.6 11.6 0 26 0 Z'
const STATIC_FACE = '/brand/wifly-mark.svg'
const ANIM_FACE = '/brand/wifly-face-animated-ink.svg'
const BEGINS = [0, 0.7, 1.4, 2.2]

function prefersReduced() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function PlayfulMarksBg() {
  const ref = useRef<HTMLDivElement>(null)
  const [faces, setFaces] = useState<string[]>(() => BEGINS.map(() => STATIC_FACE))
  const [origin, setOrigin] = useState<{ left: number; top: number; hidden: boolean }[] | null>(null)

  useEffect(() => {
    if (prefersReduced()) return
    let dead = false
    const urls: string[] = []
    fetch(ANIM_FACE)
      .then(r => r.text())
      .then(svg => {
        if (dead) return
        for (const begin of BEGINS) {
          const staggered = svg.replace(/<(animateTransform|animate) /g, `<$1 begin="${begin}s" `)
          const url = URL.createObjectURL(new Blob([staggered], { type: 'image/svg+xml' }))
          urls.push(url)
        }
        setFaces(urls)
      })
      .catch(() => { /* keep the static official mark */ })
    return () => { dead = true; urls.forEach(u => URL.revokeObjectURL(u)) }
  }, [])

  // Wait until the wordmark/card have a stable size, commit one pack, then freeze
  // unless the field itself resizes. Re-packing on every mutation jumped marks by
  // hundreds of pixels (and a too-early first pack could leave them under the card).
  useLayoutEffect(() => {
    const field = ref.current
    const page = field?.parentElement
    if (!field || !page) return

    let raf = 0
    let lastKey = ''
    let frozen = false
    let settle: ReturnType<typeof setTimeout> | undefined
    let candidate: { left: number; top: number; hidden: boolean }[] | null = null
    const commit = (placed: { left: number; top: number; hidden: boolean }[]) => {
      setOrigin(prev => {
        if (prev && prev.length === placed.length && prev.every((p, i) => p.left === placed[i].left && p.top === placed[i].top && p.hidden === placed[i].hidden)) return prev
        return placed
      })
    }
    const place = () => {
      const fr = field.getBoundingClientRect()
      if (fr.width < 1 || fr.height < 1) return
      const zones = MARK_CLEAR_SELECTORS.flatMap(sel =>
        [...page.querySelectorAll<HTMLElement>(sel)].map(el => {
          const b = el.getBoundingClientRect()
          return { left: b.left - fr.left, top: b.top - fr.top, right: b.right - fr.left, bottom: b.bottom - fr.top }
        }),
      ).filter(z => z.right > z.left && z.bottom > z.top)
      if (!zones.length) return
      const fieldKey = `${Math.round(fr.width)}x${Math.round(fr.height)}`
      const chromeKey = zones.map(z => [Math.round(z.left), Math.round(z.top), Math.round(z.right), Math.round(z.bottom)].join(',')).join('|')
      const key = `${fieldKey}::${chromeKey}`
      if (frozen && key.split('::')[0] === lastKey.split('::')[0] && lastKey) {
        // frozen: ignore chrome-only churn (turnstile, fonts) but re-pack on field resize
        if (fieldKey === lastKey.split('::')[0]) return
      }
      if (key === lastKey) return
      lastKey = key
      frozen = false
      candidate = placeSlots(SLOTS, fr.width, fr.height, zones)
      if (settle) clearTimeout(settle)
      settle = setTimeout(() => {
        if (!candidate) return
        const fr2 = field.getBoundingClientRect()
        const zones2 = MARK_CLEAR_SELECTORS.flatMap(sel =>
          [...page.querySelectorAll<HTMLElement>(sel)].map(el => {
            const b = el.getBoundingClientRect()
            return { left: b.left - fr2.left, top: b.top - fr2.top, right: b.right - fr2.left, bottom: b.bottom - fr2.top }
          }),
        ).filter(z => z.right > z.left && z.bottom > z.top)
        const fieldRect = { left: 0, top: 0, right: fr2.width, bottom: fr2.height }
        const hits = packingHits(candidate, SLOTS, fieldRect, zones2)
        if (hits.length) {
          lastKey = ''
          frozen = false
          candidate = placeSlots(SLOTS, fr2.width, fr2.height, zones2)
          const again = packingHits(candidate, SLOTS, fieldRect, zones2)
          if (again.length) {
            const bad = new Set(again.flatMap(h => [h.a, h.b]).filter((n): n is number => n != null))
            candidate = candidate.map((p, i) => bad.has(i) ? { ...p, hidden: true } : p)
          }
        }
        frozen = true
        commit(candidate)
      }, 250)
    }
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; place() })
    }

    place()
    const ro = new ResizeObserver(schedule)
    ro.observe(field)
    const mo = new MutationObserver(() => { if (!frozen) schedule() })
    mo.observe(page, { childList: true, subtree: true })
    const onResize = () => { frozen = false; lastKey = ''; schedule() }
    window.addEventListener('resize', onResize)
    void document.fonts?.ready?.then(() => { if (!frozen) schedule() })
    const kick = requestAnimationFrame(() => requestAnimationFrame(schedule))
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(kick)
      if (raf) cancelAnimationFrame(raf)
      if (settle) clearTimeout(settle)
    }
  }, [])

  useEffect(() => {
    const field = ref.current
    const page = field?.parentElement
    if (!field || !page) return
    if (prefersReduced()) return

    const marks = [...field.querySelectorAll<HTMLElement>('.playful-marks__mark')]
    const target = { x: 0, y: 0 }
    const cur = { x: 0, y: 0 }
    const pointer = { x: 0, y: 0 }
    let tracking = false
    let raf = 0

    const tick = () => {
      raf = 0
      cur.x = lerpToward(cur.x, target.x, PLAY_LERP)
      cur.y = lerpToward(cur.y, target.y, PLAY_LERP)
      page.style.setProperty('--play-x', cur.x.toFixed(3))
      page.style.setProperty('--play-y', cur.y.toFixed(3))
      if (tracking) {
        const fr = field.getBoundingClientRect()
        for (const el of marks) {
          const c = layoutCenter(fr, el)
          el.classList.toggle('is-hot', isHotAt(pointer.x, pointer.y, c.x, c.y))
        }
      }
      if (tracking || !atRest(cur.x, cur.y, target.x, target.y)) raf = requestAnimationFrame(tick)
    }
    const start = () => { if (!raf) raf = requestAnimationFrame(tick) }

    const onMove = (e: PointerEvent) => {
      const n = playNorm(e.clientX, e.clientY, page.getBoundingClientRect())
      target.x = n.x
      target.y = n.y
      pointer.x = e.clientX
      pointer.y = e.clientY
      tracking = true
      start()
    }
    const onLeave = () => {
      tracking = false
      target.x = 0
      target.y = 0
      marks.forEach(el => el.classList.remove('is-hot'))
      start()
    }
    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.gamma == null || e.beta == null) return
      const n = orientationNorm(e.gamma, e.beta)
      target.x = n.x
      target.y = n.y
      start()
    }
    page.addEventListener('pointermove', onMove)
    page.addEventListener('pointerleave', onLeave)
    window.addEventListener('deviceorientation', onOrient)
    return () => {
      cancelAnimationFrame(raf)
      raf = 0
      page.removeEventListener('pointermove', onMove)
      page.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('deviceorientation', onOrient)
      tracking = false
      target.x = 0
      target.y = 0
      page.style.setProperty('--play-x', '0')
      page.style.setProperty('--play-y', '0')
      marks.forEach(el => el.classList.remove('is-hot'))
    }
  }, [])

  return (
    <div className={`playful-marks${origin ? ' is-placed' : ''}`} aria-hidden="true" ref={ref}>
      {SLOTS.map((m, i) => (
        <span
          key={i}
          className={`playful-marks__mark playful-marks__mark--${COLOR[m.c]}${m.s <= 50 ? ' playful-marks__mark--sparse' : ''}${origin?.[i]?.hidden ? ' playful-marks__mark--stowed' : ''}`}
          style={{
            top: origin?.[i] != null ? origin[i].top : m.t,
            left: origin?.[i] != null ? origin[i].left : m.l,
            width: m.s,
            height: m.s,
            '--rot': `${m.r}deg`,
            '--depth': m.d,
            '--dur': `${m.dur}s`,
            '--delay': `${m.delay}s`,
          } as CSSProperties}
        >
          <span className="playful-marks__drift">
            <span className="playful-marks__react">
              <svg className="playful-marks__tile" viewBox="0 0 100 100" focusable="false">
                <path d={TILE} fill="currentColor" />
              </svg>
              <img className="playful-marks__face" src={faces[m.group] ?? STATIC_FACE} alt="" draggable={false} />
            </span>
          </span>
        </span>
      ))}
    </div>
  )
}
