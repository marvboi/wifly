/**
 * Live WIF → USD. One shared EventSource on /api/price/stream (the backend reads the Uniswap v4 pool and Chainlink
 * ETH/USD, caches it, and pushes each new price). Falls back to polling /api/price if the stream drops.
 */
import { animate, useMotionValue, useMotionValueEvent } from 'motion/react'
import { useEffect, useState, useSyncExternalStore } from 'react'

export type WifPrice = { usd: number; eth: number; wifPerEth: number; ethUsd: number; updatedAt: number; stale: boolean; source?: { wif: string; ethUsd: string } }

let price: WifPrice | null = null
let es: EventSource | null = null
let poll: number | null = null
let users = 0
const subs = new Set<() => void>()
const set = (p: WifPrice) => { price = p; subs.forEach(f => f()) }
const STALE_MS = 90_000

async function fetchOnce() {
  try { const r = await fetch('/api/price'); if (r.ok) set(await r.json()) } catch { /* keep last */ }
}
function start() {
  void fetchOnce()
  if (typeof EventSource !== 'undefined') {
    es = new EventSource('/api/price/stream')
    es.addEventListener('price', e => { try { set(JSON.parse((e as MessageEvent).data)) } catch { /* ignore */ } })
    es.onerror = () => { if (poll === null) poll = window.setInterval(fetchOnce, 20_000) }
    es.onopen = () => { if (poll !== null) { clearInterval(poll); poll = null } }
  } else poll = window.setInterval(fetchOnce, 15_000)
}
function stop() { es?.close(); es = null; if (poll !== null) clearInterval(poll); poll = null }

function subscribe(f: () => void) {
  subs.add(f)
  if (users++ === 0) start()
  return () => { subs.delete(f); if (--users === 0) stop() }
}

/** Current price; `stale` when the server says so or nothing new arrived for 90s. */
export function useWifPrice() {
  const p = useSyncExternalStore(subscribe, () => price)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t) }, [])
  return { price: p, usd: p?.usd, ethUsd: p?.ethUsd, stale: !p || p.stale || now - p.updatedAt > STALE_MS }
}

/** $ amounts: 1,234 · 12.34 · 0.42 · 0.0013 (two significant digits under a cent). */
export const usdText = (v: number) =>
  v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : v >= 0.01 ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : v > 0 ? Number(v.toPrecision(2)).toString() : '0.00'

/** "≈ $x.xx" with a smooth tick when the price moves, and a quiet stale marker. */
export function Usd({ value, className = '' }: { value: number | undefined; className?: string }) {
  const { stale } = useWifPrice()
  const mv = useMotionValue(value ?? 0)
  const [shown, setShown] = useState(value ?? 0)
  useMotionValueEvent(mv, 'change', v => setShown(v))
  useEffect(() => { if (value === undefined) return; const c = animate(mv, value, { duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }); return () => c.stop() }, [value, mv])
  // Unknown or stale price: show nothing rather than a placeholder or an old number.
  if (value === undefined || stale) return null
  return <span className={`usd num ${className}`} title="live price">≈ ${usdText(shown)}</span>
}

