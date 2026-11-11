/** Free @username input (lives in Wifly, not an NFT) with a live availability check (GET /api/handles/check) and suggestions. */
import { useEffect, useState, type FocusEventHandler, type Ref } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { NAME_MAX, NAME_MIN, RESERVED_NAMES, claimFeeOf } from '../config'
import { Icon } from './Icon'
import { cleanHandle, handleFaceMood, handleFieldError, handleFieldState, handleLogoReplacesError, type HandleCheck } from '../lib/handleName'
import { Mascot } from './Mascot'
export type { HandleCheck } from '../lib/handleName'
export { cleanHandle, handleFieldError, handleFieldState } from '../lib/handleName'

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

export function HandleField({ value, onChange, autoFocus, inputRef, onFocus, onBlur, quiet }: {
  value: string; onChange: (v: string) => void; autoFocus?: boolean
  inputRef?: Ref<HTMLInputElement>; onFocus?: FocusEventHandler<HTMLInputElement>; onBlur?: FocusEventHandler<HTMLInputElement>
  /** fewer suggestions, same live check */
  quiet?: boolean
}) {
  const { check, checking } = useHandleCheck(value)
  const state = handleFieldState(value, checking, check)
  const error = handleFieldError(check, state)
  const showError = !!error && !handleLogoReplacesError(check?.reason)
  const mood = handleFaceMood(value, state, check?.reason)
  const [hop, setHop] = useState(0)
  useEffect(() => { if (mood === 'happy') setHop(h => h + 1) }, [mood])
  return (
    <div className={`handle-field is-${state}`}>
      <label className="handle-field__box">
        <span className="handle-field__at">@</span>
        <input ref={inputRef} value={value} autoFocus={autoFocus} onFocus={onFocus} onBlur={onBlur} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={NAME_MAX}
          aria-label="username" aria-invalid={state === 'bad'} aria-describedby={showError ? 'handle-field-error' : undefined} placeholder="yourname" onChange={e => onChange(cleanHandle(e.target.value))} />
        <span className="handle-field__trail">
          {(state === 'checking' || state === 'ok') && (
            <span className="handle-field__state" aria-live="polite">
              {state === 'checking' && <span className="spinner" aria-label="checking" data-testid="handle-checking" />}
              {state === 'ok' && <Icon name="check" size={18} data-testid="handle-ok" />}
            </span>
          )}
          <span className="handle-field__face" aria-hidden="true" data-testid="handle-face"><Mascot size={32} tile={false} mood={mood} pulse={hop} title="" /></span>
        </span>
      </label>
      {showError && <p className="handle-field__error" id="handle-field-error" data-testid="handle-error">{error}</p>}
      {state === 'bad' && !!check?.suggestions?.length && (
        <div className="handle-field__sugg"><span className="tiny muted">try</span>
          {check.suggestions.slice(0, quiet ? 2 : 4).map(s => <button key={s} type="button" className="chip" onClick={() => onChange(s)}>@{s}</button>)}
        </div>
      )}
    </div>
  )
}
