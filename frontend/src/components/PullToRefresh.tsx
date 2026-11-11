/** Pull-to-refresh for the home feed: a touch pull at the top on phones, a wheel-up refetch on desktop. */
import { useEffect, useRef, useState } from 'react'

const THRESHOLD = 64
const MAX = 88

export function PullToRefresh({ onRefresh }: { onRefresh: () => Promise<void> | void }) {
  const [pull, setPull] = useState(0)
  const [state, setState] = useState<'idle' | 'pulling' | 'refreshing'>('idle')
  const pullRef = useRef(0)
  const stateRef = useRef(state)
  const startY = useRef(0)
  const tracking = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  stateRef.current = state
  pullRef.current = pull

  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0
  const blocked = () => document.body.classList.contains('no-scroll')

  const finish = async () => {
    if (stateRef.current === 'refreshing') return
    setState('refreshing')
    try { await onRefreshRef.current() } finally {
      setState('idle')
      setPull(0)
      pullRef.current = 0
    }
  }

  useEffect(() => {
    const onStart = (e: TouchEvent) => {
      if (blocked() || stateRef.current === 'refreshing' || !atTop()) { tracking.current = false; return }
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, [contenteditable="true"], .sheet, .wallet-pop')) { tracking.current = false; return }
      tracking.current = true
      startY.current = e.touches[0].clientY
    }
    const onMove = (e: TouchEvent) => {
      if (!tracking.current || blocked() || stateRef.current === 'refreshing') return
      const dy = e.touches[0].clientY - startY.current
      if (dy <= 0 || !atTop()) { if (pullRef.current) { setPull(0); pullRef.current = 0; setState('idle') } ; return }
      const dist = Math.min(MAX, dy * 0.42)
      if (dist > 4 && e.cancelable) e.preventDefault()
      pullRef.current = dist
      setPull(dist)
      setState('pulling')
    }
    const onEnd = () => {
      if (!tracking.current) return
      tracking.current = false
      if (stateRef.current === 'refreshing') return
      if (pullRef.current >= THRESHOLD) void finish()
      else { setPull(0); pullRef.current = 0; setState('idle') }
    }
    // desktop: wheel up past the top refetches once
    let wheelAcc = 0
    let wheelReset: ReturnType<typeof setTimeout> | undefined
    const onWheel = (e: WheelEvent) => {
      if (blocked() || stateRef.current === 'refreshing' || !atTop()) { wheelAcc = 0; return }
      if (e.deltaY >= 0) { wheelAcc = 0; return }
      wheelAcc += -e.deltaY
      clearTimeout(wheelReset)
      wheelReset = setTimeout(() => { wheelAcc = 0 }, 240)
      if (wheelAcc >= 80) { wheelAcc = 0; void finish() }
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd)
    document.addEventListener('touchcancel', onEnd)
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
      window.removeEventListener('wheel', onWheel)
      clearTimeout(wheelReset)
    }
  }, [])

  const on = state !== 'idle' || pull > 0
  const h = state === 'refreshing' ? 52 : pull
  const ready = pull >= THRESHOLD
  const rot = state === 'refreshing' ? undefined : Math.min(360, (pull / THRESHOLD) * 300)
  return (
    <div className={`ptr${on ? ' is-on' : ''}${state === 'refreshing' ? ' is-refreshing' : ''}${ready && state !== 'refreshing' ? ' is-ready' : ''}`}
      data-testid="ptr" data-state={state === 'refreshing' ? 'refreshing' : ready ? 'ready' : state} aria-hidden={!on}
      style={{ height: on ? h : 0 }} role="status" aria-live="polite" aria-busy={state === 'refreshing' || undefined}>
      <span className="ptr__mark" style={rot != null ? { transform: `rotate(${rot}deg)` } : undefined} />
    </div>
  )
}
