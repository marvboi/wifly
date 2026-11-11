/** Shared sign-in body: the sheet and the signed-out /welcome card use the same wording and buttons. Guest behavior is unchanged from 12.6.7. */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccount, useConnect } from 'wagmi'
import { useSession, existingGuestKey, rememberGuestBrowse } from '../api/session'
import { FEED_PATH, appHref } from '../lib/hosts'
import { guestBrowsePath, signalGuestBrowse } from '../lib/guestBrowse'
import { privyBridge, privyEnabled, wantPrivy } from '../auth/privyBridge'
import { connectBrowserWallet } from '../lib/connectBrowserWallet'
import { useStore } from '../state/store'
import { HumanCheck } from './HumanCheck'
import { Mascot } from './Mascot'
import { Icon } from './Icon'
import { RECOVER_GRACE_MS, createSignInGate, stillPending, type SignInKind, type SignInView } from '../lib/attempt'

export function SignInForm({ reason }: { reason?: string }) {
  const { closeSheet, toast } = useStore()
  const { signInGuest, signInWallet, signInPrivy } = useSession()
  const { isConnected, address } = useAccount()
  const { connectAsync, connectors } = useConnect()
  const [view, setView] = useState<SignInView>({ busy: null, line: null })
  const busy = view.busy
  const [useWallet, setUseWallet] = useState(false)
  const nav = useNavigate()
  const done = (m: { onboarded?: boolean; handle: string }) => {
    closeSheet()
    // like x: stay on the page you were reading; only a brand-new account goes through /welcome
    if (!m.onboarded) nav('/welcome'); else toast(`signed in as @${m.handle}`)
  }
  // 11.8.4b / 12.6.12: every way in runs through one gate: a "cancel" link while it waits, a 20s cap on guest only,
  // wallet/Privy wait until the user signs or rejects, late results safe.
  const doneRef = useRef(done); doneRef.current = done
  const gate = useRef<ReturnType<typeof createSignInGate<{ onboarded?: boolean; handle: string }>> | null>(null)
  gate.current ??= createSignInGate<{ onboarded?: boolean; handle: string }>({
    onView: v => setView(v),
    onSignedIn: m => doneRef.current(m),
    quiet: e => /sign-in closed|reject|denied|cancel/i.test((e as Error)?.message ?? ''),
  })
  const last = useRef<SignInKind>('guest')
  const wallet = () => { last.current = 'wallet'
    gate.current!.run('wallet', async () => {
    const addr = await connectBrowserWallet({ isConnected, address, connectors, connectAsync })
    return signInWallet(addr)
  }) }
  const guest = () => {
    // an existing key in this browser still signs in; otherwise close into signed-out browsing (never mint a key).
    if (existingGuestKey()) { last.current = 'guest'; gate.current!.run('guest', () => signInGuest()); return }
    // do not clear the signed-out flag here: that would let a leftover Privy session sign the user back in.
    rememberGuestBrowse()
    closeSheet()
    // latch + event: the feed may not be mounted yet (e.g. this card is on /welcome), so the event alone is not enough.
    signalGuestBrowse()
    const dest = appHref('/home')
    if (dest.external) { window.location.assign(dest.href); return }
    const to = guestBrowsePath(window.location.pathname, FEED_PATH)
    if (to) nav(to, { state: { guestBrowse: true } })
    else window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const privy = () => { last.current = 'privy'; gate.current!.run('privy', () => signInPrivy()) }
  const again = () => (last.current === 'wallet' ? wallet : last.current === 'privy' ? privy : guest)()
  // a wallet popup or privy's window closed without telling us: once the page is back and nothing is pending, recover
  useEffect(() => {
    const back = () => {
      if (document.visibilityState !== 'visible') return
      const g = gate.current!, k = g.busy(), id = g.attempt()
      if (!k || k === 'guest') return
      setTimeout(() => {
        if (g.attempt() !== id) return
        const s = privyBridge.get(), dlg = document.getElementById('privy-dialog')
        // wallet/privy stay pending while the sign request is in flight (stillPending is true).
        if (!stillPending(k, { authenticated: s.authenticated, dialogOpen: !!dlg && dlg.getClientRects().length > 0 })) g.recover(k)
      }, RECOVER_GRACE_MS[k])
    }
    window.addEventListener('focus', back); document.addEventListener('visibilitychange', back)
    return () => { window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back) }
  }, [])
  const status = busy
    ? <p className="signin__retry small muted" role="status" data-testid="signin-cancel">{busy === 'wallet' ? 'waiting for your wallet.' : busy === 'privy' ? 'waiting for sign-in.' : 'signing you in.'} <button type="button" className="linkbtn" onClick={() => gate.current!.cancel()}>cancel</button></p>
    : view.line ? <p className="signin__retry small muted" role="status" data-testid="signin-retry">{view.line} <button type="button" className="linkbtn" onClick={again}>try again</button></p>
    : null
  // start fetching Privy now so the modal is ready by the tap
  useEffect(() => { wantPrivy() }, [])
  if (privyEnabled && !useWallet) return (
    <div className="signin" data-testid="signin-form">
      <Mascot size={72} />
      <h3 className="signin__title">{reason ?? 'join wifly.'}</h3>
      <p className="muted small">{reason ? 'it takes about a minute. you can keep looking around after.' : 'use X, email or a wallet. it takes about a minute.'}</p>
      <HumanCheck />
      <button className="btn btn--dark btn--block" disabled={!!busy} onClick={privy}><Icon name="user" size={18} /> {busy === 'privy' ? 'opening…' : 'sign up or sign in'}</button>
      <button className="btn btn--ghost btn--block" disabled={!!busy} onClick={() => setUseWallet(true)}><Icon name="wallet" size={18} /> i have a wallet</button>
      <button className="btn btn--ghost btn--block" disabled={!!busy} onClick={guest} data-testid="signin-guest"><Icon name="user" size={18} /> {busy === 'guest' ? 'signing…' : 'try it with a guest key'}</button>
      {status}
      {reason && <button className="btn btn--text btn--block" onClick={closeSheet}>keep browsing</button>}
    </div>
  )
  return (
    <div className="signin" data-testid="signin-form">
      <Mascot size={72} />
      <h3 className="signin__title">{reason ?? 'join wifly.'}</h3>
      {reason && <p className="muted small">it takes about a minute. you can keep looking around after.</p>}
      <p className="muted small">you sign a message to prove it’s you. nothing is sent or spent.</p>
      <HumanCheck />
      <button className="btn btn--dark btn--block" disabled={!!busy} onClick={wallet}><Icon name="wallet" size={18} /> {busy === 'wallet' ? 'check your wallet…' : isConnected ? 'sign in with your wallet' : 'connect a wallet'}</button>
      <button className="btn btn--ghost btn--block" disabled={!!busy} onClick={guest} data-testid="signin-guest"><Icon name="user" size={18} /> {busy === 'guest' ? 'signing…' : 'try it with a guest key'}</button>
      {status}
      <p className="muted tiny">a guest key lives in this browser only. you can link a wallet later.</p>
      {reason && <button className="btn btn--text btn--block" onClick={closeSheet}>keep browsing</button>}
    </div>
  )
}
