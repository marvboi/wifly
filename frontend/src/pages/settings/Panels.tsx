/** Reusable panel bodies for sheets / tabs — every settings control lives here. */
import { Link } from 'react-router-dom'
import { ThemeToggle } from '../../components/ThemeToggle'
import { AvatarPicker } from '../../components/AvatarPicker'
import { Icon } from '../../components/Icon'
import { LinkList } from '../../components/LinkAccounts'
import { WalletsSection, WalletsTip } from '../../components/WalletsSection'
import { InfoTip } from '../../components/InfoTip'
import { TipDestination, UseMyWif } from '../../components/WalletProofs'
import { ListNameButton } from '../../components/ListName'
import { loginIcon, loginLine, type useSettingsModel } from './model'
import { userError } from '../../lib/txError'

type M = ReturnType<typeof useSettingsModel>

export function ProfilePanel({ m }: { m: M }) {
  const { me, name, setName, bio, setBio, avatar, pick, removeAvatar, dirty, busy, saved, save, toast } = m
  if (!me) return null
  return (
    <div className="sc-panel" data-testid="settings-profile">
      <div className="sc-panel__avatar">
        <AvatarPicker src={avatar} name={name || me.handle} handle={me.handle} size={88} onPick={pick} onRemove={removeAvatar} onError={msg => toast('couldn’t add that photo', userError(msg))} />
      </div>
      <label className="field"><span className="field__label">name</span>
        <input className="field__input" value={name} maxLength={40} onChange={e => setName(e.target.value)} autoComplete="nickname" /></label>
      <label className="field"><span className="field__label">bio</span>
        <textarea className="field__input sc-bio" value={bio} maxLength={160} rows={2} onChange={e => setBio(e.target.value)} placeholder="optional" /></label>
      <div className="sc-save">
        <span className="sc-save__st" aria-live="polite">{saved ? 'saved' : dirty ? 'unsaved' : ''}</span>
        <button className="btn btn--dark" disabled={busy || !dirty || !name.trim()} onClick={save}>{busy ? 'saving…' : 'save'}</button>
      </div>
    </div>
  )
}

export function WifPanel({ m }: { m: M }) {
  const { me, wif, usable, setCard } = m
  if (!me) return null
  return (
    <div className="sc-panel" data-testid="settings-wif">
      <div className="sc-panel__head"><span>.wif name</span><InfoTip label="about .wif names">holding a .wif makes it your name here.</InfoTip></div>
      {wif ? (
        <div className="sc-row">
          <b className="sc-wif">{wif}<span className="wifsfx">.wif</span></b>
          <div className="sc-row__acts">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCard(true)}>view card</button>
            <ListNameButton name={wif} label="list for sale" className="btn btn--ghost btn--sm" />
          </div>
        </div>
      ) : (
        <div className="sc-row">
          <span className="muted small">none yet</span>
          <Link className="btn btn--dark btn--sm" to="/names">get a .wif</Link>
        </div>
      )}
      {usable && <div className="sc-row sc-row--sub"><span className="small">also hold <b>{usable}.wif</b></span><UseMyWif /></div>}
    </div>
  )
}

export function AccountsPanel({ m }: { m: M }) {
  const { login } = m
  return (
    <div className="sc-panel" data-testid="settings-links" id="accounts">
      <div className="sc-panel__head"><span>accounts</span><InfoTip label="about linked accounts">link x or a wallet to sign in from anywhere.</InfoTip></div>
      <div className="sc-row" data-testid="login-row">
        <span className="settings__icon" aria-hidden="true"><Icon name={loginIcon(login)} size={18} /></span>
        <span className="small">{loginLine(login)}</span>
      </div>
      <LinkList />
    </div>
  )
}

export function WalletsPanel() {
  return (
    <div className="sc-panel" data-testid="settings-wallets" id="wallets">
      <div className="sc-panel__head"><span>wallets</span><WalletsTip /></div>
      <WalletsSection />
    </div>
  )
}

export function TipsPanel() {
  return (
    <div className="sc-panel" data-testid="settings-tips">
      <div className="sc-panel__head"><span>tips</span><InfoTip label="about the tip destination">tips go to this wallet. changing it needs a signature.</InfoTip></div>
      <TipDestination bare />
    </div>
  )
}

export function AppearancePanel() {
  return (
    <div className="sc-panel" data-testid="settings-appearance">
      <div className="sc-panel__head"><span>appearance</span></div>
      <div className="sc-theme">
        <span className="sc-lab">theme</span>
        <ThemeToggle labeled />
      </div>
      <div className="sc-swatches" aria-hidden="true">
        <span className="sc-swatch sc-swatch--light" />
        <span className="sc-swatch sc-swatch--auto" />
        <span className="sc-swatch sc-swatch--dark" />
      </div>
    </div>
  )
}

export function AccountPanel({ m }: { m: M }) {
  const { me, busy, out, setDel } = m
  if (!me) return null
  return (
    <div className="sc-panel" data-testid="settings-account">
      <div className="sc-row">
        <span className="mono small">@{me.handle}</span>
        <button className="btn btn--ghost btn--sm" data-testid="sign-out" disabled={busy} onClick={out}>sign out</button>
      </div>
      <div className="sc-danger" data-testid="settings-delete">
        <button className="sc-del" onClick={() => setDel(true)}>delete my account</button>
        <p className="tiny muted">.wif names and wif stay in your wallet.</p>
      </div>
    </div>
  )
}
