/** A tiny muted "i" that opens a one- or two-line note on hover or tap. Closes on outside tap or esc. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export function InfoTip({ label, children, side = 'top' }: { label: string; children: ReactNode; side?: 'top' | 'bottom' }) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setPinned(false) } }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setPinned(false) } }
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <span className="infotip" ref={ref} onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!pinned) setOpen(false) }}>
      <button type="button" className="infotip__btn" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined}
        onClick={e => { e.preventDefault(); e.stopPropagation(); const v = !(open && pinned); setPinned(v); setOpen(v) }}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 7.2v3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="8" cy="5" r=".85" fill="currentColor" /></svg>
      </button>
      {open && <span role="tooltip" id={id} className={`infotip__pop infotip__pop--${side}`}>{children}</span>}
    </span>
  )
}
