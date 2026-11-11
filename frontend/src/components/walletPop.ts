/** Place the wallet popover inside the viewport: flip, clamp, and cap height so nothing is cut off. */
export type Rect = { top: number; bottom: number; left: number; right: number }
export type PopPlace = { top: number; left: number; maxH: number; up: boolean; width: number }

export function placeWalletPop(
  anchor: Rect,
  pop: { width: number; height: number },
  view: { w: number; h: number; floor?: number },
  pad = 8,
  gap = 8,
): PopPlace {
  const width = Math.min(Math.max(pop.width, 0), Math.max(0, view.w - pad * 2))
  const floor = (view.floor ?? view.h) - pad
  const ceiling = pad
  const spaceBelow = floor - (anchor.bottom + gap)
  const spaceAbove = anchor.top - gap - ceiling
  const up = pop.height > spaceBelow && spaceAbove > spaceBelow
  const maxH = Math.max(120, up ? spaceAbove : spaceBelow)
  const h = Math.min(pop.height, maxH)
  const left = Math.min(Math.max(pad, anchor.right - width), Math.max(pad, view.w - width - pad))
  const top = up ? anchor.top - gap - h : anchor.bottom + gap
  return { top, left, maxH, up, width }
}
