/**
 * Sign-up friction that stays out of the way:
 *  - Cloudflare Turnstile, only when the backend sends a site key (/api/auth/config.turnstile). api.js loads on demand.
 *  - a hidden honeypot field ("website") that people never see or fill.
 * session.tsx reads both through humanCheck() when it creates an account.
 */
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

type TS = { render: (el: HTMLElement, o: Record<string, unknown>) => string; reset: (id?: string) => void; remove: (id: string) => void }
declare global { interface Window { turnstile?: TS } }

let token: string | undefined
let honey = ''
let widget: string | undefined
export function humanCheck() { return { turnstileToken: token, website: honey || undefined } }
/** Tokens are single use: call after a sign-up attempt. */
export function resetHumanCheck() { token = undefined; if (widget) window.turnstile?.reset(widget) }

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
    loadScript().then(() => {
      if (gone || !el.current || !window.turnstile) return
      id = window.turnstile.render(el.current, {
        sitekey: key, theme: 'light', appearance: 'interaction-only', size: 'flexible', 'refresh-expired': 'auto',
        callback: (t: string) => { token = t; setFailed(null) },
        'expired-callback': () => { token = undefined },
        // the code is public (e.g. 110200 = this hostname isn't on the widget, 600010 = challenge failed); keep it for support
        'error-callback': (code?: string | number) => { token = undefined; setFailed(String(code ?? '')); console.warn('[human-check] turnstile error', code); return true },
      })
      idRef.current = id
      widget = id
    }).catch(() => { if (!gone) setFailed('load') })
    return () => { gone = true; if (id) window.turnstile?.remove(id); if (widget === id) widget = undefined; if (idRef.current === id) idRef.current = undefined; token = undefined }
  }, [key, round])
  const retry = () => {
    setFailed(null); token = undefined
    // a widget that exists is reset in place; one that never loaded is rendered again from scratch
    if (idRef.current && window.turnstile) window.turnstile.reset(idRef.current); else setRound(r => r + 1)
  }
  return (
    <>
      <div className="hp" aria-hidden="true">
        <label>website <input name="website" tabIndex={-1} autoComplete="off" defaultValue="" onChange={e => { honey = e.target.value }} /></label>
      </div>
      {key && <div ref={el} key={round} className="humancheck" />}
      {key && failed !== null && <p className="humancheck__retry small muted" role="status" data-testid="humancheck-retry">
        the quick human check didn’t finish. <button type="button" className="linkbtn" onClick={retry}>try again</button>
      </p>}
    </>
  )
}
