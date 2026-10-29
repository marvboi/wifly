/** Free @username input (lives in Wifly, not an NFT) with a live availability check (GET /api/handles/check) and suggestions. */
import { useEffect, useState, type FocusEventHandler, type Ref } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { NAME_MAX, NAME_MIN, RESERVED_NAMES, claimFeeOf } from '../config'
import { Icon } from './Icon'

export type HandleCheck = {
  handle: string; available: boolean; reason?: 'invalid' | 'reserved' | 'taken' | 'listed' | 'x-reserved' | 'wif-owned' | 'yours'
  message?: string; price?: number; suggestions: string[]; claimFee: number; wifFree?: boolean
}
export const cleanHandle = (s: string) => s.trim().replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, NAME_MAX)

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v)
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms])
  return d
}

export function useHandleCheck(handle: string) {
  const h = useDebounced(handle)
  const local: HandleCheck | null = h.length < NAME_MIN ? { handle: h, available: false, reason: 'invalid', message: `at least ${NAME_MIN} characters`, suggestions: [], claimFee: claimFeeOf(h) }
    : RESERVED_NAMES.includes(h) ? { handle: h, available: false, reason: 'reserved', message: 'that one is reserved', suggestions: [], claimFee: claimFeeOf(h) } : null
  const q = useQuery({ queryKey: ['handle-check', h], queryFn: () => api<HandleCheck>(`/handles/check?h=${encodeURIComponent(h)}`), enabled: !local && !!h, staleTime: 10_000 })
  const settled = h === handle
  return { check: local ?? (q.data?.handle === h ? q.data : undefined), checking: !settled || q.isFetching }
}

const LABEL: Record<string, string> = { reserved: 'reserved', taken: 'taken', listed: 'taken · for sale', 'x-reserved': 'taken', 'wif-owned': 'taken onchain', invalid: 'not valid', yours: 'yours' }

export function HandleField({ value, onChange, autoFocus, inputRef, onFocus, onBlur, quiet }: {
  value: string; onChange: (v: string) => void; autoFocus?: boolean
  inputRef?: Ref<HTMLInputElement>; onFocus?: FocusEventHandler<HTMLInputElement>; onBlur?: FocusEventHandler<HTMLInputElement>
  /** calm mode: the count and rules show only while the field is focused or something is wrong */
  quiet?: boolean
}) {
  const { check, checking } = useHandleCheck(value)
  const [focused, setFocused] = useState(false)
  const state = !value ? 'idle' : checking ? 'checking' : check?.available ? 'ok' : 'bad'
  const showRules = !quiet || focused || state === 'bad'
  return (
    <div className={`handle-field is-${state}`}>
      <label className="handle-field__box">
        <span className="handle-field__at">@</span>
        <input ref={inputRef} value={value} autoFocus={autoFocus} onFocus={e => { setFocused(true); onFocus?.(e) }} onBlur={e => { setFocused(false); onBlur?.(e) }} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={NAME_MAX}
          aria-label="username" aria-invalid={state === 'bad'} placeholder="yourname" onChange={e => onChange(cleanHandle(e.target.value))} />
        <span className="handle-field__state" aria-live="polite">
          {state === 'checking' && <span className="spinner" aria-label="checking" />}
          {state === 'ok' && <><Icon name="check" size={14} /> {check?.reason === 'yours' ? 'yours' : 'available'}</>}
          {state === 'bad' && <>{LABEL[check?.reason ?? 'invalid'] ?? 'not available'}</>}
        </span>
      </label>
      <div className={`handle-field__meta ${showRules ? '' : 'is-hidden'}`}>
        {(!quiet || focused) && <span className="tiny muted">{value.length}/{NAME_MAX} · a–z, 0–9 and _</span>}
        {state === 'bad' && check?.message && check.message.trim().toLowerCase() !== (LABEL[check?.reason ?? 'invalid'] ?? 'not available') && <span className="tiny">{check.message}{check.price ? ` for ${check.price.toLocaleString()} wif` : ''}</span>}
      </div>
      {state === 'bad' && !!check?.suggestions?.length && (
        <div className="handle-field__sugg"><span className="tiny muted">try</span>
          {check.suggestions.slice(0, quiet ? 2 : 4).map(s => <button key={s} type="button" className="chip" onClick={() => onChange(s)}>@{s}</button>)}
        </div>
      )}
    </div>
  )
}
