/** /settings: the small set of account settings the onboarding promises: display name, photo, linked accounts, sign out. */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { adoptUser, api, uploadAvatar } from '../api/client'
import { useSession, type Login } from '../api/session'
import { useStore } from '../state/store'
import { FEED_PATH } from '../lib/hosts'
import { AvatarPicker } from '../components/AvatarPicker'
import { PageHead } from '../components/Shell'
import { Icon, type IconName } from '../components/Icon'
import { Mascot } from '../components/Mascot'
import { LinkList } from '../components/LinkAccounts'
import { InfoTip } from '../components/InfoTip'
import { TipDestination, UseMyWif } from '../components/WalletProofs'
import { RemoveAccountSheet } from '../components/AccountRemove'
import { AnimatePresence } from 'motion/react'

export function Settings() {
  const { me, ready, setMe, signOut, login } = useSession()
  const { toast, openSheet } = useStore()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [name, setName] = useState(me?.name ?? '')
  const [avatar, setAvatar] = useState<string | null>(me?.avatar ?? null)
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(false)
  useEffect(() => { if (me) { setName(me.name ?? ''); setAvatar(me.avatar ?? null) } }, [me?.handle]) // eslint-disable-line react-hooks/exhaustive-deps

  if (ready && !me) return (
    <>
      <PageHead title="settings" back />
      <div className="empty empty--card">
        <Mascot size={64} />
        <p className="strong">your settings live here.</p>
        <p className="muted small">sign in to change your name and photo.</p>
        <button className="btn btn--dark btn--sm" onClick={() => openSheet({ type: 'signin' })}>sign in</button>
      </div>
    </>
  )
  if (!me) return <PageHead title="settings" back />

  const dirty = name.trim() !== (me.name ?? '') || avatar !== (me.avatar ?? null)
  const save = async () => {
    setBusy(true)
    try {
      const r = await api<{ me: typeof me }>('/me', { method: 'PATCH', json: { name: name.trim(), ...(avatar !== (me.avatar ?? null) ? { avatar } : {}) } })
      adoptUser({ ...r.me, you: true }); setMe(r.me)
      void qc.invalidateQueries(); toast('saved')
    } catch (e) { toast('couldn’t save', (e as Error).message) } finally { setBusy(false) }
  }
  const pick = async (f: File) => {
    try { setAvatar(await uploadAvatar(f)) } catch (e) { toast('couldn’t add that photo', (e as Error).message) }
  }
  const out = async () => {
    setBusy(true)
    try { await signOut(); nav(FEED_PATH, { replace: true }) } catch (e) { toast('couldn’t sign out', (e as Error).message) } finally { setBusy(false) }
  }

  return (
    <>
      <PageHead title="settings" back />
      <div className="settings-page">
        <section className="card settings-page__card">
          <h2 className="settings-page__h">profile</h2>
          <div className="settings-page__profile">
            <AvatarPicker src={avatar} name={name || me.handle} handle={me.handle} size={72} onPick={pick} onRemove={() => setAvatar(null)} onError={m => toast('couldn’t add that photo', m)} />
            <label className="field settings-page__name"><span className="field__label">display name</span><input className="field__input" value={name} maxLength={40} onChange={e => setName(e.target.value)} /></label>
          </div>
          <div className="settings-page__save">
            <span className="muted small">@{me.handle}</span>
            <button className="btn btn--dark btn--sm" disabled={busy || !dirty || !name.trim()} onClick={save}>{busy ? 'saving…' : 'save'}</button>
          </div>
        </section>

        <section className="card settings-page__card">
          <h2 className="settings-page__h">login</h2>
          <div className="settings-page__login" data-testid="login-row">
            <span className="settings__icon"><Icon name={loginIcon(login)} size={18} /></span>
            <span className="small">{loginLine(login)}</span>
          </div>
        </section>

        <section className="card settings-page__card" data-testid="settings-links">
          <h2 className="settings-page__h">linked accounts<InfoTip label="about linked accounts">link x or a wallet to sign in to this same account from anywhere.</InfoTip></h2>
          <LinkList />
        </section>

        <section className="card settings-page__card" data-testid="settings-wif">
          <h2 className="settings-page__h">.wif name</h2>
          {me.wifName ? <p className="small">{me.wifName}.wif <span className="muted">is your name here</span></p> : <p className="small muted">no .wif yet</p>}
          <UseMyWif />
        </section>

        <TipDestination />

        <button className="linkbtn settings-page__out" disabled={busy} onClick={out}>sign out</button>

        <section className="settings-page__danger" data-testid="settings-delete">
          <p className="tiny muted">done with wifly? you can delete your account. your .wif names and WIF stay in your wallet.</p>
          <button className="linkbtn settings-page__del" onClick={() => setDel(true)}>delete my account</button>
        </section>
      </div>
      <AnimatePresence>
        {del && <RemoveAccountSheet mode="self" handle={me.handle || null} onClose={() => setDel(false)} onConfirm={async typed => {
          await api('/me/delete', { method: 'POST', json: { confirm: typed } })
          setDel(false); toast('your account is deleted')
          await signOut().catch(() => {}); void qc.invalidateQueries(); nav(FEED_PATH, { replace: true })
        }} />}
      </AnimatePresence>
    </>
  )
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-2)}`
/** One calm, lowercase line about how this session signed in. */
function loginLine(l: Login | null): string {
  if (!l) return 'signed in'
  switch (l.method) {
    case 'wallet': return l.address ? `signed in with wallet ${short(l.address.toLowerCase())}` : 'signed in with a wallet'
    case 'guest': return 'signed in with a guest key on this browser'
    case 'x': return `signed in with x (@${l.username})`
    case 'email': return 'signed in with email'
    default: return 'signed in with x or email'
  }
}
function loginIcon(l: Login | null): IconName {
  return !l ? 'user' : l.method === 'wallet' || l.method === 'guest' ? 'wallet' : l.method === 'x' ? 'x' : l.method === 'email' ? 'mail' : 'user'
}
