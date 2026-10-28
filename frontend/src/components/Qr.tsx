/** A QR code drawn as plain svg rects, generated in the browser (nothing leaves the page, nothing for the CSP to allow). */
import { useMemo } from 'react'
import { create } from 'qrcode/lib/core/qrcode'

export function Qr({ text, size = 184, label }: { text: string; size?: number; label: string }) {
  const { n, path } = useMemo(() => {
    const m = create(text, { errorCorrectionLevel: 'M' }).modules
    let d = ''
    for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.get(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`
    return { n: m.size + 8, path: d }
  }, [text])
  return (
    <svg className="qr" role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges">
      <rect width={n} height={n} rx={3} fill="#fff" />
      <path d={path} fill="#110E08" />
    </svg>
  )
}
