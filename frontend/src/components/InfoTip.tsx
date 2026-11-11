/** A tiny muted "i" that opens a one- or two-line note on hover or tap. Portaled so it is never clipped. Closes on outside tap or esc. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Side = 'top' | 'bottom'

function placePop(anchor: DOMRect, pop: HTMLElement, preferred: Side): { top: number; left: number; side: Side } {
  const box = pop.getBoundingClientRect()
  const w = box.width, h = box.height
  const vw = window.innerWidth, vh = window.innerHeight, pad = 8, gap = 6
  const spaceTop = anchor.top - pad
  const spaceBot = vh - anchor.bottom - pad
  let side: Side = preferred
  if (side === 'top' && h + gap > spaceTop && spaceBot > spaceTop) side = 'bottom'
  if (side === 'bottom' && h + gap > spaceBot && spaceTop > spaceBot) side = 'top'
  // if neither side fully fits, pick the roomier one and clamp into the viewport
  const rawTop = side === 'top' ? anchor.top - gap - h : anchor.bottom + gap
  const top = Math.min(Math.max(pad, rawTop), Math.max(pad, vh - h - pad))
  const left = Math.min(Math.max(pad, anchor.left + anchor.width / 2 - w / 2), Math.max(pad, vw - w - pad))
  return { top, left, side }
}

export function InfoTip({ label, children, side = 'top' }: { label: string; children: ReactNode; side?: Side }) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; side: Side } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLSpanElement>(null)
  const leaveTimer = useRef<number>(0)
  const id = useId()

  const place = useCallback(() => {
    const btn = ref.current?.querySelector('button') ?? ref.current
    const pop = popRef.current
    if (!btn || !pop) return
    setPos(placePop(btn.getBoundingClientRect(), pop, side))
  }, [side])

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    place()
    // re-measure after the pop has painted at its first position (width can depend on placement)
    const id = requestAnimationFrame(() => { place() })
    return () => cancelAnimationFrame(id)
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false); setPinned(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setPinned(false) } }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place])

  const enter = () => { window.clearTimeout(leaveTimer.current); setOpen(true) }
  const leave = () => {
    if (pinned) return
    window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => setOpen(false), 140)
  }

  const pop = open && typeof document !== 'undefined' ? createPortal(
    <span role="tooltip" id={id} ref={popRef}
      className={`infotip__pop infotip__pop--float infotip__pop--${pos?.side ?? side}`}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, bottom: 'auto', right: 'auto', visibility: pos ? 'visible' : 'hidden' }}
      data-testid="infotip-pop"
      onMouseEnter={enter} onMouseLeave={leave}>
      {children}
    </span>,
    document.body,
  ) : null

  return (
    <span className="infotip" ref={ref} onMouseEnter={enter} onMouseLeave={leave}>
      <button type="button" className="infotip__btn" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined}
        onClick={e => { e.preventDefault(); e.stopPropagation(); const v = !(open && pinned); setPinned(v); setOpen(v) }}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 7.2v3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="8" cy="5" r=".85" fill="currentColor" /></svg>
      </button>
      {pop}
    </span>
  )
}

export { placePop as placeInfoTip }
