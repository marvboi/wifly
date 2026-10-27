/**
 * Slots for brand assets that the brand worker drops into src/brand.
 *
 * import.meta.glob is resolved at build time, so the moment
 * src/brand/PlusBadge.tsx or src/brand/TipJar.tsx exists, the next build uses
 * it here and everywhere these slots are used. Until then the simple
 * placeholders below render, with the same props.
 */
import type React from 'react'
import type { ComponentType } from 'react'
import { useLayoutEffect, useRef } from 'react'

// Same props as the brand worker's components (src/brand/PlusBadge.tsx, src/brand/TipJar.tsx).
export type PlusBadgeProps = { size?: number; variant?: 'inline' | 'hero'; title?: string; className?: string; style?: React.CSSProperties }
export type TipJarProps = { size?: number; animate?: boolean; count?: number; showCounter?: boolean; unit?: string; title?: string; className?: string; style?: React.CSSProperties }

type Mod<P> = { default?: ComponentType<P> } & Record<string, unknown>
const pick = <P,>(mods: Record<string, unknown>, name: string): ComponentType<P> | undefined => {
  const m = Object.values(mods)[0] as Mod<P> | undefined
  if (!m) return undefined
  return (m[name] as ComponentType<P> | undefined) ?? m.default
}

const BrandPlusBadge = pick<PlusBadgeProps>(import.meta.glob('../brand/PlusBadge.tsx', { eager: true }), 'PlusBadge')
const BrandTipJar = pick<TipJarProps>(import.meta.glob('../brand/TipJar.tsx', { eager: true }), 'TipJar')

/** Placeholder: a squircle check in ink. */
function PlusBadgeFallback({ size = 14, className, title = 'wifly plus member' }: PlusBadgeProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={title}>
      <title>{title}</title>
      <rect x="0.5" y="0.5" width="15" height="15" rx="5" fill="#111" />
      <path d="M4.4 8.3l2.3 2.3 4.9-5" fill="none" stroke="#CCFF00" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Placeholder: a simple jar with a coin dropping in. `level` 0..1 fills it. */
function TipJarFallback({ size = 20, className }: TipJarProps) {
  const top = 14
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 6h10M8 6v1.5C6.3 8.6 5.5 10 5.5 12v6.5A2.5 2.5 0 0 0 8 21h8a2.5 2.5 0 0 0 2.5-2.5V12c0-2-.8-3.4-2.5-4.5V6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <clipPath id="tipjar-clip"><path d="M8 7.5C6.3 8.6 5.5 10 5.5 12v6.5A2.5 2.5 0 0 0 8 21h8a2.5 2.5 0 0 0 2.5-2.5V12c0-2-.8-3.4-2.5-4.5z" /></clipPath>
      <rect x="4" y={top} width="16" height="14" fill="#CCFF00" clipPath="url(#tipjar-clip)" />
      <circle cx="12" cy="3" r="1.8" fill="currentColor" />
    </svg>
  )
}

export const PlusBadge: ComponentType<PlusBadgeProps> = BrandPlusBadge ?? PlusBadgeFallback
export const TipJar: ComponentType<TipJarProps> = BrandTipJar ?? TipJarFallback
export const brandAssets = { plusBadge: !!BrandPlusBadge, tipJar: !!BrandTipJar }

/** Badge sizes the brand file is pixel-tuned for. Anything else gets snapped to the nearest one. */
const GRID = [14, 16, 20, 24] as const
export const crispSize = (n: number) => GRID.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), GRID[0])

/**
 * The Plus badge, kept crisp: always a whole, pixel-tuned size (14/16/20/24), its own box so it never sits on a
 * fractional baseline, and nudged onto the device-pixel grid once layout settles (no transforms involved).
 * The brand component's drawing is untouched.
 */
export function PlusMark({ size = 14, className = '', title = 'wifly plus' }: { size?: number; className?: string; title?: string }) {
  const px = crispSize(size)
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let dx = 0, dy = 0
    const snap = () => {
      const r = el.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const x = r.left - dx, y = r.top - dy
      const nx = Math.round(x * dpr) / dpr - x, ny = Math.round(y * dpr) / dpr - y
      if (Math.abs(nx - dx) > 0.01 || Math.abs(ny - dy) > 0.01) { dx = nx; dy = ny; el.style.left = `${dx}px`; el.style.top = `${dy}px` }
    }
    const raf = requestAnimationFrame(snap)
    const t1 = window.setTimeout(snap, 450), t2 = window.setTimeout(snap, 1200)
    document.fonts?.ready.then(snap).catch(() => {})
    window.addEventListener('resize', snap)
    return () => { cancelAnimationFrame(raf); clearTimeout(t1); clearTimeout(t2); window.removeEventListener('resize', snap) }
  }, [px])
  return (
    <span ref={ref} className={`plus-mark ${className}`} style={{ width: px, height: px }}>
      <PlusBadge size={px} title={title} style={{ display: 'block', verticalAlign: 'top' }} />
    </span>
  )
}
