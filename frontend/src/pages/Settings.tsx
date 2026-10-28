/** /settings: grouped and short. profile, your name, accounts, tips, then the account zone (sign out, delete). */
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { adoptUser, api, uploadAvatar } from '../api/client'
import { useSession, type Login } from '../api/session'
import { useStore } from '../state/store'
import { FEED_PATH } from '../lib/hosts'
import { AvatarPicker } from '../components/AvatarPicker'
import { PageHead } from '../components/Shell'
import { Icon, type IconName } from '../components/Icon'
import { Mascot } from '../components/Mascot'
import { LinkList } from '../components/LinkAccounts'
import { WalletsSection, WalletsTip } from '../components/WalletsSection'
import { InfoTip } from '../components/InfoTip'
import { TipDestination, UseMyWif } from '../components/WalletProofs'
import { RemoveAccountSheet } from '../components/AccountRemove'
import { AnimatePresence } from 'motion/react'
import { Sheet } from '../sheets/Sheets'
import { NameCard } from '../components/WifName'
import { ListNameButton } from '../components/ListName'

export function Settings() {
  const { me, ready, setMe, signOut, login } = useSession()
  const { toast, openSheet } = useStore()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [name, setName] = useState(me?.name ?? '')
  const [bio, setBio] = useState(me?.bio ?? '')
  const [avatar, setAvatar] = useState<string | null>(me?.avatar ?? null)
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(false)
  const [card, setCard] = useState(false)
  const mine = useQuery({ queryKey: ['names', 'mine', me?.handle], queryFn: () => api<{ usable: string | null; names: { name: string; theme: number; primary: boolean }[] }>('/names/mine'), enabled: !!me })
  useEffect(() => { if (me) { setName(me.name ?? ''); setBio(me.bio ?? ''); setAvatar(me.avatar ?? null) } }, [me?.handle]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (me && (location.hash === '#accounts' || location.hash === '#wallets')) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' }) }, [!!me]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const dirty = name.trim() !== (me.name ?? '') || bio.trim() !== (me.bio ?? '') || avatar !== (me.avatar ?? null)
  const wif = me.wifName ?? null
  const usable = mine.data?.usable && mine.data.usable !== wif ? mine.data.usable : null
  const theme = mine.data?.names.find(n => n.name === wif)?.theme
  const save = async () => {
    setBusy(true)
    try {
      const r = await api<{ me: typeof me }>('/me', { method: 'PATCH', json: { name: name.trim(), bio: bio.trim(), ...(avatar !== (me.avatar ?? null) ? { avatar } : {}) } })
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
      <div className="settings-page set">
        <section className="set__group" data-testid="settings-profile">
          <h2 className="set__h">profile</h2>
          <div className="card set__card">
            <div className="settings-page__profile">
              <AvatarPicker src={avatar} name={name || me.handle} handle={me.handle} size={72} onPick={pick} onRemove={() => setAvatar(null)} onError={m => toast('couldn’t add that photo', m)} />
              <label className="field settings-page__name"><span className="field__label">name</span><input className="field__input" value={name} maxLength={40} onChange={e => setName(e.target.value)} /></label>
            </div>
            <label className="field"><span className="field__label">bio</span><textarea className="field__input set__bio" value={bio} maxLength={160} rows={3} onChange={e => setBio(e.target.value)} placeholder="a line about you" /></label>
            <div className="settings-page__save">
              <span className="muted small">@{me.handle}</span>
              <button className="btn btn--dark btn--sm" disabled={busy || !dirty || !name.trim()} onClick={save}>{busy ? 'saving…' : 'save'}</button>
            </div>
          </div>
        </section>

        <section className="set__group" data-testid="settings-wif">
          <h2 className="set__h">your name<InfoTip label="about .wif names">a .wif is an onchain name. holding one makes it your name here.</InfoTip></h2>
          <div className="card set__card">
            {wif ? <>
              <div className="set__row">
                <span className="set__wif"><b>{wif}<span className="wifsfx">.wif</span></b><span className="muted tiny">your name here · @{me.handle}</span></span>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCard(true)}>view card</button>
              </div>
              <div className="set__row set__row--end"><ListNameButton name={wif} label="list for sale" className="btn btn--ghost btn--sm" /></div>
            </> : (
              <div className="set__row">
                <span className="small muted">no .wif yet</span>
                <Link className="btn btn--dark btn--sm" to="/names">get a .wif</Link>
              </div>)}
            {usable && <div className="set__row set__row--sub"><span className="small">you also hold <b>{usable}.wif</b></span><UseMyWif /></div>}
          </div>
        </section>

        <section className="set__group" id="accounts" data-testid="settings-links">
          <h2 className="set__h">accounts<InfoTip label="about linked accounts">link x or a wallet to sign in to this same account from anywhere.</InfoTip></h2>
          <div className="card set__card">
            <div className="settings-page__login" data-testid="login-row">
              <span className="settings__icon"><Icon name={loginIcon(login)} size={18} /></span>
              <span className="small">{loginLine(login)}</span>
            </div>
            <LinkList />
          </div>
        </section>

        <section className="set__group" id="wallets" data-testid="settings-wallets">
          <h2 className="set__h">wallets<WalletsTip /></h2>
          <div className="card set__card"><WalletsSection /></div>
        </section>

        <section className="set__group" data-testid="settings-tips">
          <h2 className="set__h">tips<InfoTip label="about the tip destination">tips go straight to this wallet. changing it needs a signature from the new wallet.</InfoTip></h2>
          <div className="card set__card"><TipDestination bare /></div>
        </section>

        <section className="set__group" data-testid="settings-account">
          <h2 className="set__h">account</h2>
          <div className="card set__card">
            <div className="set__row">
              <span className="small muted">signed in as @{me.handle}</span>
              <button className="btn btn--ghost btn--sm" data-testid="sign-out" disabled={busy} onClick={out}>sign out</button>
            </div>
            <div className="set__danger" data-testid="settings-delete">
              <button className="set__del" onClick={() => setDel(true)}>delete my account</button>
              <p className="tiny muted">your .wif names and WIF stay in your wallet.</p>
            </div>
          </div>
        </section>
      </div>
      <AnimatePresence>{card && wif && (
        <Sheet title={`${wif}.wif`} onClose={() => setCard(false)}>
          <div className="profile__wifsheet" data-testid="wif-card"><NameCard size="md" label={wif} state="yours" theme={theme} /></div>
        </Sheet>)}</AnimatePresence>
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
