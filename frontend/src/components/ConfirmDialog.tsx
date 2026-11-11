/** In-site confirm, in the same sheet style as the rest of wifly. Replaces window.confirm. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

export type ConfirmOpts = {
  title: string
  hint?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

type Pending = ConfirmOpts & { resolve: (ok: boolean) => void }

const ConfirmCtx = createContext<(opts: ConfirmOpts) => Promise<boolean>>(() => Promise.resolve(false))

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

function ConfirmModal({ pending }: { pending: Pending }) {
  const wrap = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = () => pending.resolve(false)
  const ok = () => pending.resolve(true)

  useEffect(() => {
    const root = dialog.current
    const prev = document.activeElement as HTMLElement | null
    const list = () => [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(el => !el.hasAttribute('disabled'))
    const start = list()
    ;(start[0] ?? root)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() }
      if (e.key !== 'Tab' || !root) return
      const f = list()
      if (!f.length) return
      const first = f[0], last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    document.body.classList.add('no-scroll')
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.classList.remove('no-scroll')
      prev?.focus?.()
    }
  }, [pending])

  const confirmLabel = pending.confirmLabel ?? 'delete'
  const cancelLabel = pending.cancelLabel ?? 'cancel'

  return createPortal(
    <div className="sheet-wrap confirm-wrap" role="presentation" ref={wrap}
      onMouseDown={e => { if (e.target === e.currentTarget) cancel() }}>
      <div className="sheet sheet--sm confirm-dialog" role="dialog" aria-modal="true"
        aria-labelledby="confirm-title" aria-describedby={pending.hint ? 'confirm-hint' : undefined}
        ref={dialog} tabIndex={-1}>
        <div className="sheet__grab" aria-hidden="true" />
        <header className="sheet__head">
          <h2 className="sheet__title" id="confirm-title">{pending.title}</h2>
          <button className="icon-btn" type="button" onClick={cancel} aria-label="close"><Icon name="close" size={20} /></button>
        </header>
        <div className="sheet__body">
          {pending.hint && <p className="muted" id="confirm-hint">{pending.hint}</p>}
        </div>
        <footer className="sheet__foot confirm-dialog__foot">
          <button type="button" className="btn btn--ghost btn--lg" onClick={cancel}>{cancelLabel}</button>
          <button type="button" className={`btn btn--lg ${pending.danger ? 'btn--danger' : 'btn--dark'}`} onClick={ok} data-testid="confirm-ok">{confirmLabel}</button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const ask = useCallback((opts: ConfirmOpts) => new Promise<boolean>(resolve => {
    setPending({
      ...opts,
      resolve: (ok: boolean) => { setPending(null); resolve(ok) },
    })
  }), [])
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {pending && <ConfirmModal pending={pending} />}
    </ConfirmCtx.Provider>
  )
}

export function useConfirm() {
  return useContext(ConfirmCtx)
}
