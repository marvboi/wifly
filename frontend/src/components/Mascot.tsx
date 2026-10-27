/**
 * The Wifly face as a live mascot (the companion): eyes follow the cursor and glance around when idle, it blinks
 * on its own, and its "w" mouth reacts. Moods: calm, happy (big w), wow (o mouth), think (eyes scan side to side,
 * used for loading), oops (eyes drop, small squint), sleepy (heavy lids, slow breathing, little z's; hover wakes it). `pulse` (any changing number) triggers a celebration hop. Geometry comes from the brand worker's
 * src/brand/wiflyFaceCore.ts so it always matches the logo. Writes SVG attributes in rAF, no re-renders.
 */
import { useEffect, useRef } from 'react'
import {
  EYE, HEAD_D, INK, MOUTH_CALM, MOUTH_HAPPY, MOUTH_O, MOUTH_W_CALM, MOUTH_W_HAPPY, MOUTH_W_O, NEON, bodyTransform, eyeBox, mouthD, restState,
  type FaceState,
} from '../brand/wiflyFaceCore'

const TILE = 'M26 0 H74 C88.4 0 100 11.6 100 26 V74 C100 88.4 88.4 100 74 100 H26 C11.6 100 0 88.4 0 74 V26 C0 11.6 11.6 0 26 0 Z'
const MAX = { x: 5.6, y: 4.2 }
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export type Mood = 'calm' | 'happy' | 'wow' | 'think' | 'oops' | 'sleepy'

/** A point on screen (client px) the mascot should look at, e.g. the caret of the field being typed in. */
export type LookPoint = { x: number; y: number } | null

export function Mascot({ size = 160, happy = false, mood = 'calm', pulse = 0, shake = 0, lookAt, tile = true, className, title = 'wifly' }: {
  size?: number; happy?: boolean; mood?: Mood; pulse?: number; shake?: number; lookAt?: { current: LookPoint }; tile?: boolean; className?: string; title?: string
}) {
  const svg = useRef<SVGSVGElement>(null)
  const body = useRef<SVGGElement>(null)
  const eL = useRef<SVGRectElement>(null)
  const eR = useRef<SVGRectElement>(null)
  const mouth = useRef<SVGPathElement>(null)
  const hover = useRef(false)
  const happyProp = useRef(happy)
  happyProp.current = happy || mood === 'happy'
  const moodRef = useRef<Mood>(mood)
  moodRef.current = mood
  const hop = useRef(0)
  useEffect(() => { if (pulse) hop.current = performance.now() }, [pulse])
  const shook = useRef(0)
  useEffect(() => { if (shake) shook.current = performance.now() }, [shake])
  const lookRef = useRef(lookAt)
  lookRef.current = lookAt

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    const look = { tx: 0, ty: 0, x: 0, y: 0 }
    let h = 0, hv = 0 // happy amount + velocity (spring)
    let blinkAt = performance.now() + 1200, blinkEnd = 0
    let w = 0, o = 0 // wow (o mouth) and oops amounts
    let lastMove = 0, glanceAt = performance.now() + 1500, glance = { x: 0, y: 0 }
    // aim at a screen point: direction from the face, pupil offset clamped to the eye
    const aim = (x: number, y: number) => {
      const r = svg.current?.getBoundingClientRect(); if (!r) return null
      const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height * 0.45)
      const d = Math.hypot(dx, dy) || 1, reach = Math.min(1, d / (r.width * 1.2))
      return { x: Math.max(-MAX.x, Math.min(MAX.x, (dx / d) * MAX.x * reach)), y: Math.max(-MAX.y, Math.min(MAX.y, (dy / d) * MAX.y * reach)) }
    }
    const onMove = (ev: PointerEvent) => {
      lastMove = performance.now()
      const a = aim(ev.clientX, ev.clientY); if (a) { look.tx = a.x; look.ty = a.y }
    }
    // reduced motion: no tracking, no idle glances, no hops or shakes; the face stays still and only changes expression
    if (!reduced) window.addEventListener('pointermove', onMove, { passive: true })
    // pause the work while the face is off screen (feeds can mount several)
    let onScreen = true
    const io = typeof IntersectionObserver !== 'undefined' && svg.current ? new IntersectionObserver(([en]) => { onScreen = en.isIntersecting }) : null
    if (io && svg.current) io.observe(svg.current)
    let tilt = 0
    const tick = (now: number) => {
      if (!onScreen || document.hidden) { raf = requestAnimationFrame(tick); return }
      const m0 = moodRef.current
      const sleepy = m0 === 'sleepy' && !hover.current
      const m: Mood = m0 === 'sleepy' ? 'calm' : m0
      let tx = look.tx, ty = look.ty
      const pt = reduced ? null : lookRef.current?.current ?? null
      const watching = !!pt
      if (pt) { const a = aim(pt.x, pt.y); if (a) { tx = a.x; ty = a.y } }
      if (reduced) { tx = 0; ty = 0 }
      if (watching && m !== 'think' && m !== 'oops') { /* keep looking at the field */ }
      else if (m === 'think') { tx = Math.sin(now / 420) * MAX.x * 0.9; ty = -MAX.y * 0.6 }
      else if (m === 'oops') { tx = 0; ty = MAX.y }
      else if (m === 'wow') { tx *= 0.3; ty = -MAX.y * 0.5 }
      else if (sleepy) { tx = 0; ty = MAX.y * 0.55 }
      else if (!reduced && !watching && now - lastMove > 2500) { // idle: glance around on its own
        if (now > glanceAt) { const r = Math.random(); glance = r < 0.35 ? { x: -MAX.x, y: -1 } : r < 0.7 ? { x: MAX.x, y: -1 } : { x: 0, y: 0 }; glanceAt = now + 900 + Math.random() * 1800 }
        tx = glance.x; ty = glance.y
      }
      look.x += (tx - look.x) * 0.16; look.y += (ty - look.y) * 0.16
      w += ((m === 'wow' ? 1 : 0) - w) * 0.18; o += ((m === 'oops' ? 1 : 0) - o) * 0.18
      const target = hover.current || happyProp.current ? 1 : 0
      if (reduced) h = target
      else { hv += (target - h) * 0.12; hv *= 0.72; h += hv } // under-damped: a little overshoot = bounce
      let blink = 1
      if (!reduced) {
        if (now > blinkAt) { blinkEnd = now + 150; blinkAt = now + 2600 + Math.random() * 3200 }
        if (now < blinkEnd) blink = Math.max(0.08, Math.abs((blinkEnd - now) / 75 - 1))
      }
      const hc = Math.max(0, Math.min(1.15, h))
      const st: FaceState = restState({ dx: look.x, dy: look.y })
      const breath = sleepy && !reduced ? Math.sin(now / 1100) : 0
      const squint = sleepy ? 0.2 + breath * 0.04 : 1 - 0.2 * Math.min(1, hc) - 0.25 * o
      const eh = EYE.h * blink * squint
      const cy = EYE.cy + look.y + (EYE.h - EYE.h * squint) / 2 - 1.2 * hc
      st.eyeL = { ...st.eyeL, h: eh, cy }; st.eyeR = { ...st.eyeR, h: eh, cy }
      st.mouth = MOUTH_CALM.map((v, i) => lerp(lerp(v, MOUTH_HAPPY[i], Math.min(1, hc)), MOUTH_O[i], w))
      st.mouthW = lerp(lerp(MOUTH_W_CALM, MOUTH_W_HAPPY, Math.min(1, hc)), MOUTH_W_O, w)
      // celebration hop: 700ms jump with squash on take-off and landing
      const ht = (now - hop.current) / 700
      const jump = hop.current && ht < 1 && !reduced ? Math.sin(ht * Math.PI) : 0
      const land = hop.current && ht >= 0.85 && ht < 1.15 && !reduced ? Math.sin(((ht - 0.85) / 0.3) * Math.PI) : 0
      st.sx = 1 + hv * 0.35 + land * 0.12; st.sy = 1 - hv * 0.35 - land * 0.12 + jump * 0.06 + breath * 0.018 // squash on the change of mood
      // head tilt toward the field it watches; a short 'hmm' shake when something isn't right
      tilt += ((watching ? look.x * 1.1 : 0) - tilt) * 0.12
      const sk = (now - shook.current) / 420
      const shakeX = shook.current && sk < 1 && !reduced ? Math.sin(sk * Math.PI * 5) * (1 - sk) * 3.2 : 0
      body.current?.setAttribute('data-jump', jump.toFixed(3))
      body.current?.setAttribute('transform', `translate(${shakeX.toFixed(2)} ${(-jump * 14).toFixed(2)}) rotate(${tilt.toFixed(2)} 50 60) ${bodyTransform(st)}`)
      for (const [el, e] of [[eL.current, st.eyeL], [eR.current, st.eyeR]] as const) {
        if (!el) continue
        const b = eyeBox(e)
        el.setAttribute('x', b.x.toFixed(2)); el.setAttribute('y', b.y.toFixed(2))
        el.setAttribute('height', b.height.toFixed(2)); el.setAttribute('rx', b.rx.toFixed(2))
      }
      mouth.current?.setAttribute('d', mouthD(st.mouth))
      mouth.current?.setAttribute('stroke-width', st.mouthW.toFixed(2))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); io?.disconnect(); window.removeEventListener('pointermove', onMove) }
  }, [])

  const st = restState(), L = eyeBox(st.eyeL), R = eyeBox(st.eyeR)
  const fill = tile ? NEON : '#fff'
  const face = (
    <g ref={body} transform={bodyTransform(st)}>
      <path d={HEAD_D} fill={INK} />
      <rect ref={eL} x={L.x} y={L.y} width={L.width} height={L.height} rx={L.rx} fill={fill} />
      <rect ref={eR} x={R.x} y={R.y} width={R.width} height={R.height} rx={R.rx} fill={fill} />
      <path ref={mouth} d={mouthD(st.mouth)} fill="none" stroke={fill} strokeWidth={st.mouthW} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  )
  return (
    <svg ref={svg} viewBox="0 0 100 100" width={size} height={size} className={className} role="img" aria-label={title}
      onPointerEnter={() => { hover.current = true }} onPointerLeave={() => { hover.current = false }}>
      {tile ? <><path d={TILE} fill={NEON} /><g transform="translate(50 50.5) scale(0.66) translate(-50 -52)">{face}</g></> : face}
      {mood === 'sleepy' && <g className="mascot__z" fill={INK} aria-hidden="true"><text x="74" y="30" fontSize="13" fontWeight="700">z</text><text x="82" y="20" fontSize="9" fontWeight="700">z</text></g>}
    </svg>
  )
}
