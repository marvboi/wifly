/**
 * Light / dark / auto theme for the whole app. index.html's inline script (theme-init.mjs) sets html[data-theme]
 * before first paint; this module keeps it in sync with the settings switch, the more-sheet toggle, the system
 * setting (live, on auto) and other tabs. Switching is a soft cross-fade by default (a View Transition where
 * supported, a short colour transition otherwise). Landing / docs can pass an origin for a circular wipe from
 * the toggle. Instant under reduced motion.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { THEME_KEY, THEME_PICKED_KEY, themePrefFrom } from '../../theme-init.mjs'

export type ThemePref = 'light' | 'dark' | 'system'
export type Theme = 'light' | 'dark'
export type ThemeOrigin = { x: number; y: number }

const BG: Record<Theme, string> = { light: '#FFFFFF', dark: '#0D0C0A' }
const html = () => document.documentElement
const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches
const systemTheme = (): Theme => (mq('(prefers-color-scheme: dark)') ? 'dark' : 'light')

/** Light by default. Dark, or auto, only when the person picked it (see theme-init.mjs). */
function readPref(): ThemePref {
  try { return themePrefFrom(localStorage.getItem(THEME_KEY), localStorage.getItem(THEME_PICKED_KEY)) } catch { /* private mode */ }
  return 'light'
}

let pref: ThemePref = typeof window === 'undefined' ? 'light' : readPref()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())
const resolve = (p: ThemePref): Theme => (p === 'system' ? systemTheme() : p)

function paintMeta() {
  const t = (html().dataset.theme as Theme) || 'light'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BG[t])
}

function apply(t: Theme) {
  const d = html()
  d.dataset.theme = t
  d.setAttribute('data-themed', '')
  d.style.colorScheme = t
  d.style.backgroundColor = BG[t]
  paintMeta()
}

type StartVT = (cb: () => void) => { ready: Promise<void>; finished: Promise<void> }

/** Switch to `t`. With `from`, a circular wipe from that point; otherwise a calm cross-fade. */
function switchTo(t: Theme, from?: ThemeOrigin) {
  const d = html()
  if (d.dataset.theme === t) { flushSync(emit); return }
  if (mq('(prefers-reduced-motion: reduce)') || document.visibilityState === 'hidden') { apply(t); flushSync(emit); return }
  const start = (document as Document & { startViewTransition?: StartVT }).startViewTransition
  if (start && from) {
    const r = Math.hypot(Math.max(from.x, innerWidth - from.x), Math.max(from.y, innerHeight - from.y))
    d.classList.add('theme-vt-circle')
    try {
      const vt = start.call(document, () => { apply(t); flushSync(emit) })
      vt.ready.then(() => {
        d.animate(
          { clipPath: [`circle(0px at ${from.x}px ${from.y}px)`, `circle(${r}px at ${from.x}px ${from.y}px)`] },
          { duration: 620, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' },
        )
      }).catch(() => {})
      vt.finished.finally(() => d.classList.remove('theme-vt-circle')).catch(() => {})
      return
    } catch { d.classList.remove('theme-vt-circle') }
  }
  if (start) {
    d.classList.add('theme-vt')
    try {
      const vt = start.call(document, () => { apply(t); flushSync(emit) })
      vt.finished.finally(() => d.classList.remove('theme-vt')).catch(() => {})
      return
    } catch { d.classList.remove('theme-vt') }
  }
  // No View Transitions (firefox): a short colour fade.
  d.classList.add('theme-fade')
  apply(t)
  flushSync(emit)
  window.setTimeout(() => d.classList.remove('theme-fade'), 380)
}

export function setThemePref(next: ThemePref, from?: ThemeOrigin) {
  pref = next
  // every pick is saved with the marker, so an explicit auto is told apart from an old default
  try { localStorage.setItem(THEME_KEY, next); localStorage.setItem(THEME_PICKED_KEY, '1') } catch { /* ignore */ }
  switchTo(resolve(next), from)
}

if (typeof window !== 'undefined') {
  // Follow the system live while on "system"; follow other tabs.
  matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (pref === 'system') switchTo(systemTheme()) })
  window.addEventListener('storage', e => { if (e.key === THEME_KEY || e.key === THEME_PICKED_KEY || e.key === null) { pref = readPref(); switchTo(resolve(pref)) } })
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snap = () => `${pref}:${typeof document === 'undefined' ? 'light' : html().dataset.theme || 'light'}`

export function useTheme() {
  const [p, t] = useSyncExternalStore(subscribe, snap, () => 'light:light').split(':') as [ThemePref, Theme]
  return { pref: p, theme: t, setPref: setThemePref }
}

/** Every page follows the theme now; kept so the landing and docs can still call it. Repaints the meta colour. */
export function useThemedPage() {
  useEffect(() => { apply((html().dataset.theme as Theme) || resolve(pref)) }, [])
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') apply((html().dataset.theme as Theme) || resolve(pref))
