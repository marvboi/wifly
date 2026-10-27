/**
 * Privy bridge. The Privy SDK lives in its own lazy chunk (auth/PrivyMount.tsx) and only loads when
 * VITE_PRIVY_APP_ID is set. The rest of the app talks to it through this small store, so nothing else imports Privy
 * and builds without an app id stay on the wallet + guest sign-in.
 * The app id is public. The Privy app secret is server only and never appears in the frontend.
 */
import { useSyncExternalStore } from 'react'
import { useAccount } from 'wagmi'

export const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID ?? '').trim()
export const privyEnabled = PRIVY_APP_ID.length > 0

export type PrivyState = {
  loaded: boolean          // the Privy chunk mounted
  ready: boolean           // Privy finished restoring its own session
  authenticated: boolean
  identityToken: string | null
  smartWallet: string | null
  embeddedWallet: string | null
  xUsername: string | null       // linked X account, if any
  linkedWallet: string | null     // an external wallet linked to the account, if any
  activeWallet: string | null     // the wallet Privy signs with: embedded (X/email logins) or external (MetaMask, Rabby, WalletConnect)
}
/** What the api accepts for a Privy sign-in: the identity token when the dashboard returns one, else the access token. */
export type PrivyTokens = { identityToken: string } | { accessToken: string }
type Actions = {
  /** resolves when login (and wallet creation) completes, rejects if the modal closes. X logins may leave the page. */
  login: (methods?: ('twitter' | 'email' | 'wallet')[]) => Promise<void>
  logout: () => Promise<void>
  getIdentityToken: () => Promise<string | null>
  getAccessToken: () => Promise<string | null>
  linkTwitter: () => Promise<void>  // resolves when linked, rejects on error or when the window closes
  linkWallet: () => Promise<void>
  /** Send one tx from activeWallet on chainId. Embedded and external Privy wallets go through the same EIP-1193 path. */
  sendTx?: (to: `0x${string}`, data: `0x${string}`, chainId: number, value?: bigint) => Promise<`0x${string}`>
}

/** Lazy loading: the Privy chunk (~1.5MB) mounts only once something wants it: a sign-in tap or sheet, an account
 *  link, a Privy session left in this browser, an OAuth return, or a signed-in account that isn't a local guest key.
 *  Visitors who are only looking around never download it. */
const PRIVY_KEYS = /^privy:(token|refresh_token|id_token|pat|connections|state_code|code_verifier|headless_oauth)/
export function hasPrivyTrace(): boolean {
  if (!privyEnabled || typeof window === 'undefined') return false
  try {
    if (/[?&]privy_oauth_/.test(location.search)) return true
    if (/(?:^|;\s*)privy-/.test(document.cookie)) return true
    for (let i = 0; i < localStorage.length; i++) if (PRIVY_KEYS.test(localStorage.key(i) ?? '')) return true
    if (new URLSearchParams(location.search).get('sheet') === 'signin') return true
  } catch { /* storage blocked: wait for a tap */ }
  return false
}
let wanted = hasPrivyTrace()
const wantSubs = new Set<() => void>()
export const privyWanted = {
  get: () => wanted,
  subscribe(f: () => void) { wantSubs.add(f); return () => { wantSubs.delete(f) } },
}
/** Ask for the Privy chunk. Safe to call many times; a no-op when Privy is off. */
export function wantPrivy() { if (!privyEnabled || wanted) return; wanted = true; wantSubs.forEach(f => f()) }
export function usePrivyWanted() { return useSyncExternalStore(privyWanted.subscribe, privyWanted.get) }

let state: PrivyState = { loaded: false, ready: false, authenticated: false, identityToken: null, smartWallet: null, embeddedWallet: null, xUsername: null, linkedWallet: null, activeWallet: null }
let actions: Actions | null = null
const subs = new Set<() => void>()

export const privyBridge = {
  get: () => state,
  set(patch: Partial<PrivyState>) {
    const next = { ...state, ...patch }
    if ((Object.keys(next) as (keyof PrivyState)[]).every(k => next[k] === state[k])) return
    state = next; subs.forEach(f => f())
  },
  register(a: Actions) { actions = a },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f) } },
  async login(methods?: ('twitter' | 'email' | 'wallet')[]): Promise<PrivyTokens> {
    wantPrivy()
    if (!actions) await until(() => !!actions && state.ready)
    await actions!.login(methods)
    return privyBridge.tokens()
  },
  /**
   * The token to hand the api. The identity token shows up a moment after login (and never when the dashboard's
   * "return user data in an identity token" is off), so wait for it briefly, then fall back to the access token,
   * which the server checks with the app secret. Every miss is logged with the real reason.
   */
  async tokens(): Promise<PrivyTokens> {
    if (!actions) throw new Error('sign-in is still loading, try again')
    for (let i = 0; i < 4; i++) {
      const t = await actions.getIdentityToken().catch(e => { console.error('[sign-in] identity token failed:', e); return null }) ?? state.identityToken
      if (t) return { identityToken: t }
      await new Promise(r => setTimeout(r, 350 * (i + 1)))
    }
    console.error('[sign-in] no identity token after login. turn on "return user data in an identity token" in the privy dashboard (user management → authentication → advanced). falling back to the access token.')
    const a = await actions.getAccessToken().catch(e => { console.error('[sign-in] access token failed:', e); return null })
    if (a) return { accessToken: a }
    console.error('[sign-in] no privy token at all: the privy session did not start (check allowed origins in the privy dashboard)')
    throw new Error('sign-in didn’t finish. try again in a moment')
  },
  /** Optional account links from onboarding and settings. No-ops until the Privy chunk is mounted and signed in. */
  link(kind: 'twitter' | 'wallet') { if (!actions || !state.authenticated) return false; void (kind === 'twitter' ? actions.linkTwitter : actions.linkWallet)().catch(e => console.error('[link]', e)); return true },
  /** Fresh identity token (after a link, so the api learns the new X handle). */
  identityToken: async () => (wantPrivy(), actions ? await actions.getIdentityToken().catch(() => null) : null),
  /** True when Privy has a signed-in session in this browser right now. */
  signedIn: () => !!actions && state.ready && state.authenticated,
  /** Waits (briefly) for the sign-in service to restore its session. 'ready' = linking can run now. */
  async linkReady(ms = 8000): Promise<'ready' | 'no-session' | 'unavailable'> {
    if (!privyEnabled) return 'unavailable'
    wantPrivy()
    try { await until(() => !!actions && state.ready, ms) } catch { return 'unavailable' }
    return state.authenticated ? 'ready' : 'no-session'
  },
  /** Link X or a wallet. Resolves true when linked, false when the person closed the window; throws on real errors. */
  async linkAsync(kind: 'twitter' | 'wallet'): Promise<boolean> {
    const r = await privyBridge.linkReady()
    if (r !== 'ready') throw new Error(`link unavailable: ${r}`)
    try { await (kind === 'twitter' ? actions!.linkTwitter : actions!.linkWallet)(); return true }
    catch (e) { console.error('[link]', kind, e); if (/exited|closed/i.test(String((e as Error)?.message ?? e))) return false; throw e }
  },
  /** True when Privy has a wallet that can sign (used when no wagmi wallet is connected). */
  canSend: () => !!actions?.sendTx && !!state.activeWallet && state.authenticated,
  sendTx(to: `0x${string}`, data: `0x${string}`, chainId: number, value?: bigint) {
    if (!actions?.sendTx) return Promise.reject(new Error('connect a wallet first'))
    return actions.sendTx(to, data, chainId, value)
  },
  /** Logging out also clears a Privy session that was never loaded this visit. */
  async logout() { if (!actions && hasPrivyTrace()) { wantPrivy(); await until(() => !!actions && state.ready, 8000).catch(() => {}) } if (actions && state.authenticated) await actions.logout().catch(() => {}) },
}

function until(ok: () => boolean, ms = 15_000) {
  return new Promise<void>((resolve, reject) => {
    if (ok()) return resolve()
    const t = setTimeout(() => { off(); reject(new Error('sign-in is still loading, try again')) }, ms)
    const off = privyBridge.subscribe(() => { if (ok()) { clearTimeout(t); off(); resolve() } })
  })
}

export function usePrivyState() { return useSyncExternalStore(privyBridge.subscribe, privyBridge.get) }

/** The signing address, whichever kind of wallet it is: a wagmi wallet (injected / WalletConnect) or a Privy wallet
 * (embedded for X/email logins, or external). Both are treated the same everywhere a tx is built or a balance read. */
export function useAnyAccount(): { address: `0x${string}` | undefined } {
  const { address } = useAccount()
  const p = usePrivyState()
  return { address: address ?? (p.authenticated && p.activeWallet ? p.activeWallet as `0x${string}` : undefined) }
}
