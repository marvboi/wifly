/** the two-step "delete my account" / admin "remove" sheet. Step 1 explains, step 2 asks for the typed @name. */
import { useState } from 'react'
import { Sheet } from '../sheets/Sheets'
import { Icon } from './Icon'

export function RemoveAccountSheet({ handle, mode, onClose, onConfirm }: {
  handle: string | null; mode: 'self' | 'admin'; onClose: () => void; onConfirm: (typed: string) => Promise<void>
}) {
  const [step, setStep] = useState<1 | 2>(1)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const want = handle ? handle.toLowerCase() : mode === 'self' ? 'delete' : 'remove'
  const clean = typed.trim().replace(/^@/, '').toLowerCase()
  const match = clean === want || (mode === 'admin' && clean === 'remove')
  const self = mode === 'self'
  const go = async () => {
    setBusy(true); setErr(null)
    try { await onConfirm(clean) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Sheet title={self ? 'delete my account' : `remove ${handle ? `@${handle}` : 'this account'}`} onClose={onClose}
      footer={step === 1
        ? <div className="acct-del__foot"><button className="btn btn--ghost btn--lg" onClick={onClose}>keep {self ? 'my account' : 'it'}</button><button className="btn btn--dark btn--lg" onClick={() => setStep(2)}>continue</button></div>
        : <div className="acct-del__foot"><button className="btn btn--ghost btn--lg" onClick={() => setStep(1)}>back</button><button className="btn btn--dark btn--lg" disabled={!match || busy} onClick={go}>{busy ? (self ? 'deleting…' : 'removing…') : self ? 'delete my account' : 'remove account'}</button></div>}>
      {step === 1 ? (
        <div className="acct-del">
          <p className="small">{self ? 'here’s what happens when you delete your account:' : 'removing this account does the same as when someone deletes their own:'}</p>
          <ul className="acct-del__list">
            <li><Icon name="user" size={16} /><span>the profile is cleared and {self ? 'your' : 'its'} posts are hidden.</span></li>
            <li><Icon name="at" size={16} /><span>{handle ? `@${handle}` : 'the @name'} is freed for someone else.</span></li>
            <li><Icon name="wallet" size={16} /><span>x, email and wallets are unlinked, so they can start a fresh account.</span></li>
            <li><Icon name="close" size={16} /><span>every session is signed out.</span></li>
          </ul>
          <div className="acct-del__note">
            <Icon name="check" size={16} />
            <span className="small">onchain things stay in the wallet: .wif names, badges and wif tips belong to the wallet, not to wifly.</span>
          </div>
        </div>
      ) : (
        <div className="acct-del">
          <p className="small">{handle ? <>type <b>@{handle}</b>{mode === 'admin' ? <> or <b>remove</b></> : null} to confirm.</> : <>type <b>{want}</b> to confirm.</>}</p>
          <label className="field"><input className="field__input" autoFocus value={typed} onChange={e => setTyped(e.target.value)} placeholder={handle ? `@${handle}` : want}
            autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="confirm" /></label>
          {err && <p className="small acct-del__err">{err}</p>}
        </div>
      )}
    </Sheet>
  )
}
