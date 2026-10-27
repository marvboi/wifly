import { useEffect, useId, useRef } from 'react'
import {
  HEAD_D, INK, NEON, WHITE, LOOP_MS, bodyTransform, coinSVG, coinTransform, eyeBox, loopState, mouthD, restState,
  type FaceState, type Look,
} from './wiflyFaceCore'

export type WiflyFaceVariant = 'badge' | 'ink' | 'white' | 'white-on-ink'

export interface WiflyFaceProps {
  /** Rendered size in px (square). Default 48. */
  size?: number
  /** Plays the 4s loop: glances, blink, a $WIF coin drops in, gulp, happy w. Default false (static logo). */
  animated?: boolean
  /** Eyes follow the pointer while it moves; the loop takes back over ~1.2s after the pointer stops. */
  followCursor?: boolean
  /** badge = neon tile + ink face; ink / white = face only with knocked-out features. Default 'badge'. */
  variant?: WiflyFaceVariant
  /** Accessible label. Pass '' to mark the mark decorative. Default 'Wifly'. */
  title?: string
  /** Where the official coin art (wif-coin-256.png) is served from. Default '/brand'. */
  coinBase?: string
  className?: string
  style?: React.CSSProperties
}

const TILE =
  'M26 0 H74 C88.4 0 100 11.6 100 26 V74 C100 88.4 88.4 100 74 100 H26 C11.6 100 0 88.4 0 74 V26 C0 11.6 11.6 0 26 0 Z'
const FACE_IN_TILE = 'translate(50 50.5) scale(0.66) translate(-50 -52)'
const MAX_LOOK = { x: 5.6, y: 4.2 }

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/**
 * The Wifly face. Static by default; `animated` plays the brand loop, `followCursor` makes the eyes
 * track the pointer. Honours prefers-reduced-motion (stays static, cursor-follow still works since it
 * is user driven). Updates attributes directly in rAF, so it never re-renders React per frame.
 */
export function WiflyFace({
  size = 48, animated = false, followCursor = false, variant = 'badge', title = 'Wifly', coinBase = '/brand', className, style,
}: WiflyFaceProps) {
  const uid = useId().replace(/:/g, '')
  const svgRef = useRef<SVGSVGElement>(null)
  const bodyRef = useRef<SVGGElement>(null)
  const eyeL = useRef<SVGRectElement>(null)
  const eyeR = useRef<SVGRectElement>(null)
  const mouth = useRef<SVGPathElement>(null)
  const coin = useRef<SVGGElement>(null)
  const look = useRef<{ target: Look; cur: Look; at: number } | null>(null)

  const badge = variant === 'badge'
  const faceFill = variant === 'ink' || badge ? INK : WHITE
  const featureFill = badge ? NEON : variant === 'white-on-ink' ? INK : '#000'
  const knock = variant === 'ink' || variant === 'white'

  useEffect(() => {
    const reduced = prefersReducedMotion()
    const play = animated && !reduced
    if (!play && !followCursor) return
    let raf = 0
    const t0 = performance.now()

    const apply = (st: FaceState) => {
      bodyRef.current?.setAttribute('transform', bodyTransform(st))
      for (const [el, e] of [[eyeL.current, st.eyeL], [eyeR.current, st.eyeR]] as const) {
        if (!el) continue
        const b = eyeBox(e)
        el.setAttribute('x', b.x.toFixed(2)); el.setAttribute('y', b.y.toFixed(2))
        el.setAttribute('width', b.width.toFixed(2)); el.setAttribute('height', b.height.toFixed(2))
        el.setAttribute('rx', b.rx.toFixed(2))
      }
      mouth.current?.setAttribute('d', mouthD(st.mouth))
      mouth.current?.setAttribute('stroke-width', st.mouthW.toFixed(2))
      if (coin.current) {
        coin.current.style.visibility = st.coin.on ? 'visible' : 'hidden'
        coin.current.setAttribute('transform', coinTransform(st))
      }
    }

    const onMove = (ev: PointerEvent) => {
      const r = svgRef.current?.getBoundingClientRect()
      if (!r) return
      const dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height * 0.45)
      const d = Math.hypot(dx, dy) || 1
      const reach = Math.min(1, d / (r.width * 2.5)) // closer pointer = smaller eye travel
      const target = { dx: (dx / d) * MAX_LOOK.x * reach, dy: (dy / d) * MAX_LOOK.y * reach }
      look.current = { target, cur: look.current?.cur ?? { dx: 0, dy: 0 }, at: performance.now() }
    }
    if (followCursor) window.addEventListener('pointermove', onMove, { passive: true })

    const tick = (now: number) => {
      let override: Look | null = null
      const l = look.current
      if (l) {
        const idle = now - l.at
        const target = idle < 1200 ? l.target : { dx: 0, dy: 0 }
        l.cur = { dx: l.cur.dx + (target.dx - l.cur.dx) * 0.18, dy: l.cur.dy + (target.dy - l.cur.dy) * 0.18 }
        if (idle >= 1200 && Math.hypot(l.cur.dx, l.cur.dy) < 0.05) look.current = null
        else override = l.cur
      }
      const st = play ? loopState(((now - t0) % LOOP_MS) / 1000, override) : restState(override ?? undefined)
      apply(st)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      apply(restState())
    }
  }, [animated, followCursor])

  const st = restState()
  const L = eyeBox(st.eyeL), R = eyeBox(st.eyeR)
  const features = (fill: string) => (
    <>
      <rect ref={eyeL} x={L.x} y={L.y} width={L.width} height={L.height} rx={L.rx} fill={fill} />
      <rect ref={eyeR} x={R.x} y={R.y} width={R.width} height={R.height} rx={R.rx} fill={fill} />
      <path ref={mouth} d={mouthD(st.mouth)} fill="none" stroke={fill} strokeWidth={st.mouthW}
        strokeLinecap="round" strokeLinejoin="round" />
    </>
  )
  // the coin (official $WIF art) only exists in the animated loop, so static marks never fetch the image
  const coinEl = animated && (
    <g ref={coin} style={{ visibility: 'hidden' }} transform={coinTransform(st)}
      dangerouslySetInnerHTML={{ __html: coinSVG(`${coinBase.replace(/\/$/, '')}/wif-coin-256.png`) }} />
  )
  const face = (
    <g ref={bodyRef} transform={bodyTransform(st)}>
      {coinEl}
      {knock ? (
        <>
          <mask id={`wf-${uid}`} maskUnits="userSpaceOnUse" x="-20" y="-60" width="140" height="180">
            <rect x="-20" y="-60" width="140" height="180" fill="#fff" />
            {features('#000')}
          </mask>
          <path d={HEAD_D} fill={faceFill} mask={`url(#wf-${uid})`} />
        </>
      ) : (
        <>
          <path d={HEAD_D} fill={faceFill} />
          {features(featureFill)}
        </>
      )}
    </g>
  )

  return (
    <svg ref={svgRef} viewBox="0 0 100 100" width={size} height={size} className={className} style={style}
      role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title || undefined}>
      {title ? <title>{title}</title> : null}
      {variant === 'white-on-ink' && <rect width="100" height="100" rx="24" fill={INK} />}
      {badge ? (
        <>
          <path d={TILE} fill={NEON} />
          <g transform={FACE_IN_TILE}>{face}</g>
        </>
      ) : face}
    </svg>
  )
}

export default WiflyFace
