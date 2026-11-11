/**
 * Keep bouncing background marks out of a clear zone around welcome UI
 * and out of each other. Marks that cannot be placed with room for bounce
 * and mouse-follow are stowed (same idea as the existing sparse hide),
 * never stacked. Bounce and mouse-follow stay on their own wrappers.
 */
export type Rect = { left: number; top: number; right: number; bottom: number }
export type PlacedMark = { left: number; top: number; hidden: boolean }

/** Bounce (10×14) + max relative mouse travel + a little air. */
export const MARK_CLEAR_PAD = 32

/** Existing sparse rule: marks this size or smaller hide at or below this width. */
export const MARK_SPARSE_SIZE = 50
export const MARK_SPARSE_MAX_WIDTH = 720

/** Foreground welcome UI the marks must stay clear of. */
export const MARK_CLEAR_SELECTORS = ['.wordmark', '.welcome__dots', '.welcome__card', '.welcome__host', '.welcome__say'] as const

export function inflate(r: Rect, pad: number): Rect {
  return { left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad }
}

export function overlaps(a: Rect, b: Rect, eps = 0.05): boolean {
  return a.left < b.right - eps && a.right > b.left + eps && a.top < b.bottom - eps && a.bottom > b.top + eps
}

export function rect(left: number, top: number, size: number): Rect {
  return { left, top, right: left + size, bottom: top + size }
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const r = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  }
  return r.right > r.left && r.bottom > r.top ? r : null
}

/** Extra px the rotated square’s AABB sticks out past the layout box, each side. */
export function rotatedInset(size: number, deg: number): number {
  const rad = (deg * Math.PI) / 180
  const aabb = size * (Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad)))
  return (aabb - size) / 2
}

export function markAabb(left: number, top: number, size: number, deg: number): Rect {
  const inset = rotatedInset(size, deg)
  return { left: left - inset, top: top - inset, right: left + size + inset, bottom: top + size + inset }
}

export function parseSlotEdge(value: string, basis: number): number {
  const n = Number.parseFloat(value)
  if (!Number.isFinite(n)) return 0
  return value.trim().endsWith('%') ? (n / 100) * basis : n
}

export function slotRect(slot: { l: string; t: string; s: number; r?: number }, fieldW: number, fieldH: number): Rect {
  return markAabb(parseSlotEdge(slot.l, fieldW), parseSlotEdge(slot.t, fieldH), slot.s, slot.r ?? 0)
}

function travel(a: Rect, b: Rect): number {
  return Math.abs(a.left - b.left) + Math.abs(a.top - b.top)
}

function visibleHits(mark: Rect, zones: readonly Rect[], field?: Rect): number {
  const vis = field ? intersect(mark, field) : mark
  if (!vis) return 0
  let n = 0
  for (const z of zones) if (overlaps(vis, z)) n++
  return n
}

/** Smallest axis-aligned nudge that takes the visible part of the mark out of every zone. Off-canvas peeking is allowed. */
export function clearMark(mark: Rect, zones: readonly Rect[], field?: Rect, rounds = 8): Rect {
  let cur = mark
  for (let i = 0; i < rounds; i++) {
    if (visibleHits(cur, zones, field) === 0) return cur
    const vis = field ? intersect(cur, field) ?? cur : cur
    const hit = zones.find(z => overlaps(vis, z))
    if (!hit) return cur
    const w = cur.right - cur.left
    const h = cur.bottom - cur.top
    const candidates: Rect[] = [
      { left: hit.left - w, top: cur.top, right: hit.left, bottom: cur.top + h },
      { left: hit.right, top: cur.top, right: hit.right + w, bottom: cur.top + h },
      { left: cur.left, top: hit.top - h, right: cur.left + w, bottom: hit.top },
      { left: cur.left, top: hit.bottom, right: cur.left + w, bottom: hit.bottom + h },
    ]
    candidates.sort((a, b) => visibleHits(a, zones, field) - visibleHits(b, zones, field) || travel(a, cur) - travel(b, cur))
    const next = candidates[0]
    if (next.left === cur.left && next.top === cur.top) break
    cur = next
  }
  return cur
}

function isFree(mark: Rect, obstacles: readonly Rect[], field: Rect): boolean {
  return !!intersect(mark, field) && visibleHits(mark, obstacles, field) === 0
}

/** Find a spot near `start` that clears every obstacle, or null if none exists. */
export function findSpot(start: Rect, obstacles: readonly Rect[], field: Rect, step = 16): Rect | null {
  if (isFree(start, obstacles, field)) return start
  const nudged = clearMark(start, obstacles, field, 12)
  if (isFree(nudged, obstacles, field)) return nudged

  const w = start.right - start.left
  const h = start.bottom - start.top
  const minL = Math.floor((-w + 20) / step) * step
  const maxL = Math.ceil((field.right - 20) / step) * step
  const minT = Math.floor((-h + 20) / step) * step
  const maxT = Math.ceil((field.bottom - 20) / step) * step

  let best: Rect | null = null
  let bestScore = Infinity
  for (let top = minT; top <= maxT; top += step) {
    for (let left = minL; left <= maxL; left += step) {
      const cand = { left, top, right: left + w, bottom: top + h }
      if (!isFree(cand, obstacles, field)) continue
      const vis = intersect(cand, field)
      if (!vis) continue
      const visArea = (vis.right - vis.left) * (vis.bottom - vis.top)
      const score = travel(cand, start) - visArea * 0.001
      if (score < bestScore) {
        best = cand
        bestScore = score
      }
    }
  }
  return best
}

export function placeSlots(
  slots: readonly { l: string; t: string; s: number; r?: number }[],
  fieldW: number,
  fieldH: number,
  zones: readonly Rect[],
  pad = MARK_CLEAR_PAD,
): PlacedMark[] {
  const field = { left: 0, top: 0, right: fieldW, bottom: fieldH }
  const chrome = zones.filter(z => z.right > z.left && z.bottom > z.top).map(z => inflate(z, pad))
  const hideSparse = fieldW <= MARK_SPARSE_MAX_WIDTH
  const out: PlacedMark[] = slots.map(s => ({
    left: parseSlotEdge(s.l, fieldW),
    top: parseSlotEdge(s.t, fieldH),
    hidden: hideSparse && s.s <= MARK_SPARSE_SIZE,
  }))
  const order = slots
    .map((_, i) => i)
    .filter(i => !out[i].hidden)
    .sort((a, b) => slots[b].s - slots[a].s || a - b)
  const taken: Rect[] = []
  for (const i of order) {
    const s = slots[i]
    const found = findSpot(slotRect(s, fieldW, fieldH), [...chrome, ...taken], field)
    if (!found) {
      out[i].hidden = true
      continue
    }
    const inset = rotatedInset(s.s, s.r ?? 0)
    out[i] = { left: found.left + inset, top: found.top + inset, hidden: false }
    taken.push(inflate(found, pad))
  }
  return out
}

export type PackingHit = { kind: 'chrome' | 'mark'; a: number; b?: number }

/** Visible, motion-padded collisions: mark vs chrome and mark vs mark. Hidden marks are ignored. */
export function packingHits(
  placed: readonly PlacedMark[],
  slots: readonly { s: number; r?: number }[],
  field: Rect,
  chrome: readonly Rect[],
  pad = MARK_CLEAR_PAD,
): PackingHit[] {
  const hits: PackingHit[] = []
  const boxes = placed.map((p, i) => {
    if (p.hidden) return null
    return intersect(markAabb(p.left, p.top, slots[i].s, slots[i].r ?? 0), field)
  })
  const chromeZ = chrome.filter(z => z.right > z.left && z.bottom > z.top).map(z => inflate(z, pad))
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]
    if (!a) continue
    for (const z of chromeZ) if (overlaps(a, z)) hits.push({ kind: 'chrome', a: i })
    const aPad = inflate(a, pad)
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j]
      if (!b) continue
      if (overlaps(aPad, b)) hits.push({ kind: 'mark', a: i, b: j })
    }
  }
  return hits
}
