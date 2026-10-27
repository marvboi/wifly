/**
 * Sign-up friction that stays out of the way:
 *  - Cloudflare Turnstile, only when the backend sends a site key (/api/auth/config.turnstile). api.js loads on demand.
 *  - a hidden honeypot field ("website") that people never see or fill.
 * session.tsx reads both through humanCheck() when it creates an account.
 */
import { useEffect, useRef } from 'react'
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
  useEffect(() => {
    if (!key || !el.current) return
    let id: string | undefined, gone = false
    loadScript().then(() => {
      if (gone || !el.current || !window.turnstile) return
      id = window.turnstile.render(el.current, {
        sitekey: key, theme: 'light', appearance: 'interaction-only', size: 'flexible',
        callback: (t: string) => { token = t }, 'expired-callback': () => { token = undefined }, 'error-callback': () => { token = undefined },
      })
      widget = id
    }).catch(() => { /* backend fails closed; the error shows on submit */ })
    return () => { gone = true; if (id) window.turnstile?.remove(id); if (widget === id) widget = undefined; token = undefined }
  }, [key])
  return (
    <>
      <div className="hp" aria-hidden="true">
        <label>website <input name="website" tabIndex={-1} autoComplete="off" defaultValue="" onChange={e => { honey = e.target.value }} /></label>
      </div>
      {key && <div ref={el} className="humancheck" />}
    </>
  )
}
