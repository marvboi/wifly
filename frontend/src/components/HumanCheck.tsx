/**
 * Silent bot protection:
 *  - Cloudflare Turnstile, only when the backend sends a site key (/api/auth/config.turnstile). api.js loads on demand.
 *  - a hidden honeypot field ("website") that people never see or fill.
 * session.tsx reads both through humanCheck() when it creates an account.
 * The check never blocks: buttons stay on, sign-in waits at most ~3.5s for a token (waitForHumanCheck), then goes ahead.
 * The widget is kept off-layout and invisible from the first frame (no reserved space, no status line, no error text).
 * If Cloudflare asks for an interaction, it stays hidden and the existing timeout fallback is used.
 */
import { useEffect, useRef } from 'react'
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
  useEffect(() => {
    if (!key || !el.current) return
    let id: string | undefined, gone = false
    hc.setActive(true)
    const quietFail = () => { if (!gone) hc.setFailed(true) }
    loadScript().then(() => {
      if (gone || !el.current || !window.turnstile) return
      id = window.turnstile.render(el.current, {
        sitekey: key, theme: 'light', appearance: 'interaction-only', size: 'flexible', 'refresh-expired': 'auto',
        callback: (t: string) => { if (!gone) hc.setToken(t) },
        'expired-callback': quietFail,
        'timeout-callback': quietFail,
        'unsupported-callback': quietFail,
        'error-callback': () => { quietFail(); return true },
      })
      widget = id
    }).catch(() => quietFail())
    return () => {
      gone = true
      if (id) { try { window.turnstile?.remove(id) } catch { /* already gone */ } }
      if (widget === id) widget = undefined
      hc.setActive(false)
    }
  }, [key])
  return (
    <>
      <div className="hp" aria-hidden="true">
        <label>website <input name="website" tabIndex={-1} autoComplete="off" defaultValue="" onChange={e => { honey = e.target.value }} /></label>
      </div>
      {key && <div ref={el} className="humancheck" aria-hidden="true" />}
    </>
  )
}
