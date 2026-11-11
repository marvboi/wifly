/** /settings — bento tile dashboard (speed.12.3). Every control reachable via sheets. */
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppLink } from '../components/AppLink'
import { LINKS } from '../config'
import { AnimatePresence } from 'motion/react'
import { api } from '../api/client'
import { FEED_PATH } from '../lib/hosts'
import { PageHead } from '../components/Shell'
import { Mascot } from '../components/Mascot'
import { RemoveAccountSheet } from '../components/AccountRemove'
import { Sheet } from '../sheets/Sheets'
import { NameCard } from '../components/WifName'
import { useQueryClient } from '@tanstack/react-query'
import { SettingsBento } from './settings/ConceptB'
import { useSettingsModel } from './settings/model'
import { useSession } from '../api/session'
import '../styles/settings-concepts.css'

/** Existing in-app links and the shipping version. No terms page is routed in the app. */
function SettingsExtras() {
  return (
    <div className="sc-sections">
      <section className="sc-section" data-testid="settings-about">
        <h2 className="sc-section__h">about</h2>
        <p className="sc-section__row"><span>version</span><span className="muted">0.12.5</span></p>
        <AppLink className="sc-section__row" to="/docs">docs</AppLink>
        <a className="sc-section__row" href={LINKS.wifX} target="_blank" rel="noreferrer">$wif on x</a>
      </section>
    </div>
  )
}

export function Settings() {
  const m = useSettingsModel()
  const { signOut } = useSession()
  const qc = useQueryClient()
  const nav = useNavigate()
  const { me, ready, openSheet, del, setDel, card, setCard, wif, wifTheme, setPanel } = m

  useEffect(() => {
    if (!me) return
    const h = location.hash.slice(1)
    if (h === 'accounts') setPanel('accounts')
    if (h === 'wallets') setPanel('wallets')
  }, [!!me]) // eslint-disable-line react-hooks/exhaustive-deps

  if (ready && !me) return (
    <>
      <PageHead title="settings" back />
      <div className="sc-page">
        <div className="empty empty--card set-out sc-out" data-testid="settings-signed-out">
          <Mascot size={72} mood="calm" />
          <p className="strong">sign in to manage your settings.</p>
          <p className="muted small">profile, wallets, tips and look.</p>
          <button className="btn btn--dark" onClick={() => openSheet({ type: 'signin' })}>sign in</button>
        </div>
        <SettingsExtras />
        <div className="sc-dock-clear" aria-hidden="true" />
      </div>
    </>
  )
  if (!me) return <PageHead title="settings" back />

  return (
    <>
      <PageHead title="settings" back />
      <div className="settings-page sc-page">
        <SettingsBento m={m} />
        <SettingsExtras />
        <div className="sc-dock-clear" aria-hidden="true" />
      </div>

      <AnimatePresence>{card && wif && (
        <Sheet title={`${wif}.wif`} onClose={() => setCard(false)}>
          <div className="profile__wifsheet" data-testid="wif-card"><NameCard size="md" label={wif} state="yours" theme={wifTheme} /></div>
        </Sheet>
      )}</AnimatePresence>
      <AnimatePresence>
        {del && <RemoveAccountSheet mode="self" handle={me.handle || null} onClose={() => setDel(false)} onConfirm={async typed => {
          await api('/me/delete', { method: 'POST', json: { confirm: typed } })
          setDel(false); m.toast('your account is deleted')
          await signOut().catch(() => {}); void qc.invalidateQueries(); nav(FEED_PATH, { replace: true })
        }} />}
      </AnimatePresence>
    </>
  )
}
