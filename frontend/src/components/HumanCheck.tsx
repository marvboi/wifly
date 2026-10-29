/**
 * Sign-up friction that stays out of the way:
 *  - Cloudflare Turnstile, only when the backend sends a site key (/api/auth/config.turnstile). api.js loads on demand.
 *  - a hidden honeypot field ("website") that people never see or fill.
 * session.tsx reads both through humanCheck() when it creates an account.
 * The check never blocks: buttons stay on, sign-in waits at most ~3.5s for a token (waitForHumanCheck), then goes ahead.
 * A widget error, expiry or timeout shows a calm "try again" that resets the widget.
 */
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import * as hc from './humanCheckState'

type TS = { render: (el: HTMLElement, o: Record<string, unknown>) => string; reset: (id?: string) => void; remove: (id: string) => void }
declare global { interface Window { turnstile?: TS } }

let honey = ''
let widget: string | undefined
export { waitForHumanCheck } from './humanCheckState'
export function humanCheck() { return { turnstileToken: hc.getToken(), website: honey || undefined } }
/** Tokens are single use: call after a sign-up attempt. */
export function resetHumanCheck() { hc.clearToken(); if (widget) { try { window.turnstile?.reset(widget) } catch { /* widget gone */ } } }
/** No token after this long (invisible widget stuck): show the calm retry line. Sign-in already goes ahead by then. */
const STUCK_MS = 4000

let loading: Promise<void> | null = null
function loadScript() {
  if (window.turnstile) return Promise.resolve()
  loading ??= new Promise((res, rej) => {
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true; s.onload = () => res(); s.onerror = () => { loading = null; rej(new Error('turnstile failed to load')) }
    document.head.appendChild(s)
  })
  return loading
}

export function HumanCheck() {
  const cfg = useQuery({ queryKey: ['auth-config'], staleTime: 600_000, queryFn: () => api<{ turnstile?: string | null }>('/auth/config') })
  const key = cfg.data?.turnstile
  const el = useRef<HTMLDivElement>(null)
  const idRef = useRef<string | undefined>(undefined)
  // a failed or expired check gets a calm retry instead of a dead "verification failed" box
  const [failed, setFailed] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!key || !el.current) return
    let id: string | undefined, gone = false
    hc.setActive(true)
    const fail = (why: string) => { if (gone) return; hc.setFailed(true); setFailed(why) }
    // invisible mode can sit there without a callback: after a few seconds offer the retry (nothing waits on it)
    const stuck = setTimeout(() => { if (!hc.getToken()) fail('timeout') }, STUCK_MS)
    loadScript().then(() => {
      if (gone || !el.current || !window.turnstile) return
      id = window.turnstile.render(el.current, {
        sitekey: key, theme: 'light', appearance: 'interaction-only', size: 'flexible', 'refresh-expired': 'auto',
        callback: (t: string) => { clearTimeout(stuck); hc.setToken(t); setFailed(null) },
        'expired-callback': () => fail('expired'),
        'timeout-callback': () => fail('timeout'),
        'unsupported-callback': () => fail('unsupported'),
        // the code is public (e.g. 110200 = this hostname isn't on the widget, 600010 = challenge failed); keep it for support
        'error-callback': (code?: string | number) => { fail(String(code ?? '')); console.warn('[human-check] turnstile error', code); return true },
      })
      idRef.current = id
      widget = id
    }).catch(() => fail('load'))
    return () => {
      gone = true; clearTimeout(stuck)
      if (id) { try { window.turnstile?.remove(id) } catch { /* already gone */ } }
      if (widget === id) widget = undefined; if (idRef.current === id) idRef.current = undefined
      hc.setActive(false)
    }
  }, [key, round])
  const retry = () => {
    setFailed(null); hc.setFailed(false); hc.clearToken()
    // a widget that exists is reset in place; one that never loaded is rendered again from scratch
    if (idRef.current && window.turnstile) {
      try { window.turnstile.reset(idRef.current) } catch { setRound(r => r + 1); return }
      // give the reset its own few seconds; if it stays quiet the line comes back (sign-in never waits on it)
      setTimeout(() => { if (!hc.getToken() && idRef.current) { hc.setFailed(true); setFailed(f => f ?? 'timeout') } }, STUCK_MS)
    } else setRound(r => r + 1)
  }
  return (
    <>
      <div className="hp" aria-hidden="true">
        <label>website <input name="website" tabIndex={-1} autoComplete="off" defaultValue="" onChange={e => { honey = e.target.value }} /></label>
      </div>
      {key && <div ref={el} key={round} className="humancheck" />}
      {key && failed !== null && <p className="humancheck__retry small muted" role="status" data-testid="humancheck-retry">
        the quick check is taking a moment. you can still continue, or <button type="button" className="linkbtn" onClick={retry}>try again</button>
      </p>}
    </>
  )
}
