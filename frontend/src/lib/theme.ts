/**
 * Light / dark theme for the landing and docs (the app stays light for now). index.html's inline script
 * (theme-init.mjs) sets html[data-theme] before first paint; this module keeps it in sync with the toggle, the
 * system setting (live) and other tabs. Switching uses a circular View Transition from the toggle where supported,
 * a short colour fade otherwise, and is instant under reduced motion.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { THEME_KEY } from '../../theme-init.mjs'

export type ThemePref = 'light' | 'dark' | 'system'
export type Theme = 'light' | 'dark'

const BG: Record<Theme, string> = { light: '#FFFFFF', dark: '#0D0C0A' }
const html = () => document.documentElement
const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches
const systemTheme = (): Theme => (mq('(prefers-color-scheme: dark)') ? 'dark' : 'light')

function readPref(): ThemePref {
  try { const v = localStorage.getItem(THEME_KEY); if (v === 'light' || v === 'dark') return v } catch { /* private mode */ }
  return 'system'
}

let pref: ThemePref = typeof window === 'undefined' ? 'system' : readPref()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())
const resolve = (p: ThemePref): Theme => (p === 'system' ? systemTheme() : p)

function paintMeta() {
  const m = document.querySelector('meta[name="theme-color"]')
  const themed = html().hasAttribute('data-themed')
  m?.setAttribute('content', themed ? BG[(html().dataset.theme as Theme) || 'light'] : BG.light)
}

function apply(t: Theme) {
  html().dataset.theme = t
  paintMeta()
}

type StartVT = (cb: () => void) => { ready: Promise<void>; finished: Promise<void> }

/** Switch to `t`, animating from `from` (client px, e.g. the toggle) when we can. */
function switchTo(t: Theme, from?: { x: number; y: number }) {
  const d = html()
  if (d.dataset.theme === t) { flushSync(emit); return }
  const reduced = mq('(prefers-reduced-motion: reduce)')
  if (reduced || !d.hasAttribute('data-themed')) { apply(t); flushSync(emit); return }
  const start = (document as Document & { startViewTransition?: StartVT }).startViewTransition
  if (start && from) {
    const r = Math.hypot(Math.max(from.x, innerWidth - from.x), Math.max(from.y, innerHeight - from.y))
    d.classList.add('theme-vt')
    const vt = start.call(document, () => { apply(t); flushSync(emit) })
    vt.ready.then(() => {
      d.animate(
        { clipPath: [`circle(0px at ${from.x}px ${from.y}px)`, `circle(${r}px at ${from.x}px ${from.y}px)`] },
        { duration: 620, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' },
      )
    }).catch(() => {})
    vt.finished.finally(() => d.classList.remove('theme-vt'))
    return
  }
  // No View Transitions (Firefox): a ~300ms colour fade.
  d.classList.add('theme-fade')
  apply(t)
  flushSync(emit)
  window.setTimeout(() => d.classList.remove('theme-fade'), 340)
}

export function setThemePref(next: ThemePref, from?: { x: number; y: number }) {
  pref = next
  try { if (next === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next) } catch { /* ignore */ }
  switchTo(resolve(next), from)
}

if (typeof window !== 'undefined') {
  // Follow the system live while on "system"; follow other tabs.
  matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (pref === 'system') switchTo(systemTheme()) })
  window.addEventListener('storage', e => { if (e.key === THEME_KEY || e.key === null) { pref = readPref(); switchTo(resolve(pref)) } })
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snap = () => `${pref}:${typeof document === 'undefined' ? 'light' : html().dataset.theme || 'light'}`

export function useTheme() {
  const [p, t] = useSyncExternalStore(subscribe, snap, () => 'system:light').split(':') as [ThemePref, Theme]
  return { pref: p, theme: t, setPref: setThemePref }
}

/** Marks the page as following the theme while mounted (landing, docs). Other routes stay light. */
export function useThemedPage() {
  useEffect(() => {
    const d = html()
    if (!d.dataset.theme) d.dataset.theme = resolve(pref)
    d.setAttribute('data-themed', '')
    paintMeta()
    return () => { d.removeAttribute('data-themed'); paintMeta() }
  }, [])
}
