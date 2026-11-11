/**
 * Linking X or a wallet to the signed-in account, guests included: the same account keeps its posts, follows and name.
 * Used by the guest banner, /settings and your own profile. Conflicts come back as a plain lowercase line.
 */
import { useEffect, useState } from 'react'
import { useAccount, useConnect } from 'wagmi'
import { linkError, useSession } from '../api/session'
import { pickWalletAccount } from './WalletProofs'
import { privyEnabled } from '../auth/privyBridge'
import { useStore } from '../state/store'
import { Icon } from './Icon'
import { connectBrowserWallet } from '../lib/connectBrowserWallet'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** `keptErrors: false` for anything that isn't the accounts rows (the wallets list, a hidden guest bar), so the x error kept across the trip to x.com shows where the x row is, not wherever mounted first. */
export function useLinker({ keptErrors = true }: { keptErrors?: boolean } = {}) {
  const { linkX, linkWallet } = useSession()
  const { toast } = useStore()
  const { address, isConnected, connector } = useAccount()
  const { me } = useSession()
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
        let conn = connector
        if (!a) a = await connectBrowserWallet({ connectors, connectAsync })
        // the connected wallet is already here: let the person pick another account in their wallet
        const have = new Set((me?.links?.wallets ?? []).map(w => w.toLowerCase()))
        if (a && have.has(a.toLowerCase())) {
          const accts = await pickWalletAccount(conn).catch(() => [] as `0x${string}`[])
          a = accts.find(x => !have.has(x.toLowerCase())) ?? a
        }
        const r = await linkWallet(a!)
        toast(r.already ? 'already linked' : 'wallet linked', undefined, 'ok')
      }
    } catch (e) {
      const m = (e as Error).message || 'that didn’t go through'
      if (!/rejected|denied|closed/i.test(m)) setError(m.toLowerCase())
    } finally { setBusy(null) }
  }
  // an X link finished (or failed) after the trip to x.com and back (kept until shown, even if this wasn't mounted yet)
  useEffect(() => {
    const kept = keptErrors ? linkError.take() : null; if (kept) setError(kept)
    const err = (e: Event) => setError((e as CustomEvent<{ message: string }>).detail.message)
    const ok = () => setError(null)
    window.addEventListener('wifly:link-error', err); window.addEventListener('wifly:linked', ok)
    return () => { window.removeEventListener('wifly:link-error', err); window.removeEventListener('wifly:linked', ok) }
  }, [keptErrors])
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
  // always mounted, so it only takes a kept x error while it is actually showing
  const { run, busy, error, canX } = useLinker({ keptErrors: show })
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
