/**
 * Wifly face: geometry + the 4s loop timeline. Pure functions, no DOM.
 * Shared by WiflyFace.tsx and by the brand export scripts (video, GIF, animated SVG),
 * so the app and the brand assets always move the same way.
 * Coordinates live in a 100 x 100 box. The head sits on y 12..92.
 */

export const LOOP_MS = 4000

export const INK = '#110E08'
export const NEON = '#CCFF00'
export const WHITE = '#FFFFFF'

type P = [number, number]

/** Soft squircle head: a touch wider than tall, so it reads as a character, not a circle emoji. */
export const HEAD_D =
  'M50 12 C74.1 12 93 31 93 55 C93 79.5 76.5 92 50 92 C23.5 92 7 79.5 7 55 C7 31 25.9 12 50 12 Z'
export const HEAD_BOTTOM: P = [50, 92]

export const EYE = { lx: 37.5, rx: 62.5, cy: 42, w: 11, h: 18.5 }

/** Mouth centreline: 4 cubic segments, end -> trough -> peak -> trough -> end (13 points). */
type Mouth = number[]

function wShape(ex: number, ey: number, tx: number, ty: number, py: number): Mouth {
  const L: P = [50 - ex, ey], TL: P = [50 - tx, ty], PK: P = [50, py], TR: P = [50 + tx, ty], R: P = [50 + ex, ey]
  const pts: P[] = [
    L,
    [L[0] + 0.6, L[1] + (ty - ey) * 0.82], [TL[0] - (TL[0] - L[0]) * 0.62, ty],
    TL,
    [TL[0] + (PK[0] - TL[0]) * 0.6, ty], [PK[0] - 0.4, py + (ty - py) * 0.55],
    PK,
    [PK[0] + 0.4, py + (ty - py) * 0.55], [TR[0] - (TR[0] - PK[0]) * 0.6, ty],
    TR,
    [TR[0] + (R[0] - TR[0]) * 0.62, ty], [R[0] - 0.6, R[1] + (ty - ey) * 0.82],
    R,
  ]
  return pts.flat()
}

/** "wow" o: a ring whose two ends meet at the top, the w's peak swings to the bottom. */
function oShape(cx: number, cy: number, r: number): Mouth {
  const k = 0.5523 * r
  const T: P = [cx, cy - r], Lf: P = [cx - r, cy], B: P = [cx, cy + r], Rt: P = [cx + r, cy]
  const pts: P[] = [
    [T[0] - 0.01, T[1]],
    [T[0] - k, T[1]], [Lf[0], Lf[1] - k], Lf,
    [Lf[0], Lf[1] + k], [B[0] - k, B[1]], B,
    [B[0] + k, B[1]], [Rt[0], Rt[1] + k], Rt,
    [Rt[0], Rt[1] - k], [T[0] + k, T[1]], [T[0] + 0.01, T[1]],
  ]
  return pts.flat()
}

export const MOUTH_CALM = wShape(17.5, 60.5, 9, 69, 62)
export const MOUTH_HAPPY = wShape(20.5, 58.5, 10.2, 72.5, 63.4)
export const MOUTH_O = oShape(50, 66.5, 6.6)
export const MOUTH_W_CALM = 6.6
export const MOUTH_W_HAPPY = 7.2
export const MOUTH_W_O = 6.4

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerpArr = (a: number[], b: number[], t: number) => a.map((v, i) => lerp(v, b[i], t))
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function mouthD(m: Mouth): string {
  const f = (i: number) => `${m[i * 2].toFixed(2)} ${m[i * 2 + 1].toFixed(2)}`
  return `M${f(0)} C${f(1)} ${f(2)} ${f(3)} C${f(4)} ${f(5)} ${f(6)} C${f(7)} ${f(8)} ${f(9)} C${f(10)} ${f(11)} ${f(12)}`
}

/** Capsule (pill) path centred on cx, cy. */
export function pillD(cx: number, cy: number, w: number, h: number): string {
  const r = Math.min(w, h) / 2
  if (h >= w) {
    const t = cy - h / 2 + r, b = cy + h / 2 - r
    return `M${(cx - r).toFixed(2)} ${t.toFixed(2)} A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${(cx + r).toFixed(2)} ${t.toFixed(2)} V${b.toFixed(2)} A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${(cx - r).toFixed(2)} ${b.toFixed(2)} Z`
  }
  const l = cx - w / 2 + r, rr = cx + w / 2 - r
  return `M${l.toFixed(2)} ${(cy - r).toFixed(2)} H${rr.toFixed(2)} A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${rr.toFixed(2)} ${(cy + r).toFixed(2)} H${l.toFixed(2)} A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${l.toFixed(2)} ${(cy - r).toFixed(2)} Z`
}

// ---- easing + keyframes -------------------------------------------------------------------
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
type Key = [number, number] // [seconds, value]
function track(s: number, keys: Key[], ease: (t: number) => number = easeInOut): number {
  if (s <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i]
    if (s <= t1) {
      const [t0, v0] = keys[i - 1]
      return lerp(v0, v1, ease((s - t0) / (t1 - t0)))
    }
  }
  return keys[keys.length - 1][1]
}

export interface FaceState {
  eyeL: { cx: number; cy: number; w: number; h: number }
  eyeR: { cx: number; cy: number; w: number; h: number }
  mouth: Mouth
  mouthW: number
  sx: number
  sy: number
  coin: { x: number; y: number; s: number; flip: number; on: boolean }
}

export interface Look { dx: number; dy: number }

/** Resting face (also the static logo). */
export function restState(look: Look = { dx: 0, dy: 0 }): FaceState {
  return build(look, 1, 0, 0, 0, 1, 1, null)
}

function build(look: Look, blink: number, happy: number, wow: number, conv: number, sx: number, sy: number,
  coin: FaceState['coin'] | null): FaceState {
  const squint = 1 - 0.2 * happy
  const h = EYE.h * blink * squint
  const lift = (EYE.h - EYE.h * squint) / 2 // happy squint: bottom of the eye rises, top stays
  const cy = EYE.cy + look.dy + lift - 1.2 * happy
  let mouth = lerpArr(MOUTH_CALM, MOUTH_HAPPY, happy)
  mouth = lerpArr(mouth, MOUTH_O, wow)
  const mouthW = lerp(lerp(MOUTH_W_CALM, MOUTH_W_HAPPY, happy), MOUTH_W_O, wow)
  return {
    eyeL: { cx: EYE.lx + look.dx + conv, cy, w: EYE.w, h },
    eyeR: { cx: EYE.rx + look.dx - conv, cy, w: EYE.w, h },
    mouth, mouthW, sx, sy,
    coin: coin ?? { x: 50, y: -20, s: 0, flip: 1, on: false },
  }
}

/**
 * The loop, s in seconds (0..4). Beats:
 * 0.25-1.7 glance left, glance right, back to you
 * 1.85     blink
 * 2.05     eyes flick up: a $WIF coin drops in and sinks into the head, mouth goes "o"
 * 2.8      gulp: squash and stretch, big happy w, cheeks push the eyes up
 * 3.5-3.9  settle back to calm. Last frame == first frame.
 */
export function loopState(s: number, override?: Look | null): FaceState {
  s = ((s % 4) + 4) % 4
  // coin: a $WIF tip drops in from above and sinks into the top of the head (like a coin slot)
  const C0 = 2.22, C1 = 2.8
  let coin: FaceState['coin'] | null = null
  let coinY = -26
  if (s >= C0 && s < C1) {
    const t = (s - C0) / (C1 - C0)
    coinY = lerp(-26, 20, t * t)
    coin = { x: 50, y: coinY, s: 1, flip: Math.cos((s - C0) * 13), on: true }
  }
  // eyes
  let dx = track(s, [[0.25, 0], [0.5, -5.6], [0.9, -5.6], [1.15, 5.6], [1.5, 5.6], [1.72, 0]])
  let dy = track(s, [[0.25, 0], [0.5, 0.6], [0.9, 0.6], [1.15, 0.6], [1.5, 0.6], [1.72, 0]])
  // anticipation: eyes flick up before the coin shows, ride it down, and go a little cross-eyed
  let conv = 0
  if (s >= 2.05 && s < 3.15) {
    if (s < C0) dy = track(s, [[2.05, 0], [2.22, -4.6]])
    else if (s < C1) dy = clamp((coinY - EYE.cy) * 0.13, -4.6, 0)
    else dy = track(s, [[C1, clamp((20 - EYE.cy) * 0.13, -4.6, 0)], [3.12, 0]])
    conv = s < C0 ? 0 : s < C1 ? clamp((coinY + 26) / 46, 0, 1) * 1.5 : track(s, [[C1, 1.5], [3.12, 0]])
  }
  if (override) { dx = override.dx; dy = override.dy }
  const blink = Math.min(
    track(s, [[1.8, 1], [1.87, 0.08], [1.98, 1]]),
    1,
  )
  const wow = track(s, [[2.55, 0], [2.68, 1], [2.86, 1], [3.0, 0]])
  const happy = track(s, [[2.84, 0], [3.0, 1], [3.5, 1], [3.9, 0]])
  // squash and stretch, anchored at the bottom of the head
  const sy = track(s, [[2.68, 1], [2.78, 0.9], [2.94, 1.045], [3.1, 0.99], [3.22, 1]])
  const sx = track(s, [[2.68, 1], [2.78, 1.07], [2.94, 0.97], [3.1, 1.005], [3.22, 1]])
  return build({ dx, dy }, blink, happy, wow, conv, sx, sy, coin)
}

export const bodyTransform = (st: FaceState) =>
  `translate(${HEAD_BOTTOM[0]} ${HEAD_BOTTOM[1]}) scale(${st.sx.toFixed(4)} ${st.sy.toFixed(4)}) translate(${-HEAD_BOTTOM[0]} ${-HEAD_BOTTOM[1]})`

export const coinTransform = (st: FaceState) =>
  `translate(${st.coin.x.toFixed(2)} ${st.coin.y.toFixed(2)}) scale(${(st.coin.s * Math.max(0.18, Math.abs(st.coin.flip))).toFixed(3)} ${st.coin.s.toFixed(3)})`

/** Official World is Flat coin art (wif-token-flat.png cropped to its circle, resampled; not redrawn). */
export const COIN_SRC = '/brand/wif-coin-256.png'
export const COIN_R = 9.6
/** Coin drawn at the origin: the official $WIF token image, r 9.6 (same footprint as the old rimmed disc). */
export const coinSVG = (href: string = COIN_SRC) =>
  `<image href="${href}" x="${-COIN_R}" y="${-COIN_R}" width="${2 * COIN_R}" height="${2 * COIN_R}" preserveAspectRatio="xMidYMid meet"/>`

export interface Colors { face: string; feature: string; /** URL of the official coin art (defaults to COIN_SRC). */ coinHref?: string }

export interface EyeBox { x: number; y: number; width: number; height: number; rx: number }
/** Eye as a rounded rect (same attribute set in every state, so it animates cleanly). */
export function eyeBox(e: FaceState['eyeL']): EyeBox {
  return { x: e.cx - e.w / 2, y: e.cy - e.h / 2, width: e.w, height: e.h, rx: Math.min(e.w, e.h) / 2 }
}
const eyeSVG = (e: FaceState['eyeL'], fill: string) => {
  const b = eyeBox(e)
  return `<rect x="${b.x.toFixed(2)}" y="${b.y.toFixed(2)}" width="${b.width.toFixed(2)}" height="${b.height.toFixed(2)}" rx="${b.rx.toFixed(2)}" fill="${fill}"/>`
}

/** Full face as an SVG fragment in the 100 box. Features are painted in `feature` (use the background colour). */
export function faceSVG(st: FaceState, c: Colors): string {
  const coin = st.coin.on
    ? `<g transform="${coinTransform(st)}">${coinSVG(c.coinHref ?? COIN_SRC)}</g>` : ''
  return `<g transform="${bodyTransform(st)}">` + coin +
    `<path d="${HEAD_D}" fill="${c.face}"/>` +
    eyeSVG(st.eyeL, c.feature) + eyeSVG(st.eyeR, c.feature) +
    `<path d="${mouthD(st.mouth)}" fill="none" stroke="${c.feature}" stroke-width="${st.mouthW.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</g>`
}
