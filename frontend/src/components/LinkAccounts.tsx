/**
 * Linking X or a wallet to the signed-in account, guests included: the same account keeps its posts, follows and name.
 * Used by the guest banner, /settings and your own profile. Conflicts come back as a plain lowercase line.
 */
import { useEffect, useState } from 'react'
import { useAccount, useConnect } from 'wagmi'
import { useSession } from '../api/session'
import { privyEnabled } from '../auth/privyBridge'
import { useStore } from '../state/store'
import { Icon } from './Icon'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export function useLinker() {
  const { linkX, linkWallet } = useSession()
  const { toast } = useStore()
  const { address, isConnected } = useAccount()
  const { connectAsync, connectors } = useConnect()
  const [busy, setBusy] = useState<'x' | 'wallet' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (kind: 'x' | 'wallet') => {
    if (busy) return
    setBusy(kind); setError(null)
    try {
      if (kind === 'x') { if (await linkX()) toast('x linked', undefined, 'ok') }
      else {
        let a = isConnected ? address : undefined
        if (!a) { const c = connectors[0]; if (!c) throw new Error('no wallet found in this browser'); a = (await connectAsync({ connector: c })).accounts[0] }
        await linkWallet(a!)
        toast('wallet linked', undefined, 'ok')
      }
    } catch (e) {
      const m = (e as Error).message || 'that didn’t go through'
      if (!/rejected|denied|closed/i.test(m)) setError(m.toLowerCase())
    } finally { setBusy(null) }
  }
  // an X link finished (or failed) after the trip to x.com and back
  useEffect(() => {
    const err = (e: Event) => setError((e as CustomEvent<{ message: string }>).detail.message)
    window.addEventListener('wifly:link-error', err)
    return () => window.removeEventListener('wifly:link-error', err)
  }, [])
  return { run, busy, error, canX: privyEnabled }
}

/** Rows for X and wallets: what's linked, and a button for what isn't. */
export function useLinked() {
  const { me, login } = useSession()
  const x = me?.links?.x ?? null
  // a wallet sign-in counts as a linked wallet (a guest key doesn't)
  const own = login?.method === 'wallet' && login.address ? [login.address.toLowerCase()] : []
  const wallets = [...new Set([...own, ...(me?.links?.wallets ?? []).map(w => w.toLowerCase())])]
  return { x, wallets, all: !!x && wallets.length > 0 }
}

export function LinkList({ compact }: { compact?: boolean }) {
  const { me } = useSession()
  const { run, busy, error, canX } = useLinker()
  const { x, wallets } = useLinked()
  if (!me) return null
  return (
    <div className={`linklist ${compact ? 'linklist--compact' : ''}`} data-testid="link-list">
      <ul className="settings-page__links">
        <li>
          <span className="settings__icon"><Icon name="x" size={18} /></span>
          <span className="settings-page__link-name">x</span>
          {x ? <span className="small">@{x}</span>
            : canX ? <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => run('x')}>{busy === 'x' ? 'linking…' : 'link x'}</button>
            : <span className="tiny muted">soon</span>}
        </li>
        <li>
          <span className="settings__icon"><Icon name="wallet" size={18} /></span>
          <span className="settings-page__link-name">wallet</span>
          {wallets.length ? <span className="small mono">{wallets.map(short).join(', ')}</span> : null}
          <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => run('wallet')}>{busy === 'wallet' ? 'check your wallet…' : wallets.length ? 'add another' : 'link a wallet'}</button>
        </li>
      </ul>
      {error && <p className="linklist__err small" role="alert">{error}</p>}
    </div>
  )
}

/** True when this browser is on a guest key that nothing else can sign into yet. */
export function useUnownedGuest() {
  const { me, login } = useSession()
  return !!me && login?.method === 'guest' && !me.links?.x && !(me.links?.wallets?.length)
}

/** A calm strip on top of the app for guest accounts until X or a wallet is linked. */
export function GuestBanner() {
  const show = useUnownedGuest()
  const { run, busy, error, canX } = useLinker()
  if (!show) return null
  return (
    <div className="guestbar" role="region" aria-label="guest account" data-testid="guest-banner">
      <span className="guestbar__text"><Icon name="user" size={16} /> guest account. link x or a wallet so you never lose it</span>
      <span className="guestbar__acts">
        {canX && <button className="btn btn--dark btn--sm" disabled={!!busy} onClick={() => run('x')}>{busy === 'x' ? 'linking…' : 'link x'}</button>}
        <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => run('wallet')}>{busy === 'wallet' ? 'check your wallet…' : 'link a wallet'}</button>
      </span>
      {error && <span className="guestbar__err small" role="alert">{error}</span>}
    </div>
  )
}
