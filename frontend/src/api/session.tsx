/**
 * Session against the wifly api.
 * With VITE_PRIVY_APP_ID set: X or email via Privy (embedded EVM wallet for users without one; smart wallets off); the backend verifies Privy's
 * identity token. Without it, Sign-In with Ethereum, two ways in:
 *  - your wallet (wagmi): a signature, never a transaction;
 *  - a guest key kept in this browser: a throwaway key that signs the same SIWE message, for
 *    people without a wallet yet.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createSiweMessage } from 'viem/siwe'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { useAccount, useSignMessage } from 'wagmi'
import { robinhoodChain } from '../config'
import { privyBridge, privyEnabled, wantPrivy, type PrivyTokens } from '../auth/privyBridge'
import { humanCheck, resetHumanCheck } from '../components/HumanCheck'
import { adoptUser, api, getVersion, getDrop, subscribe, type ApiUser } from './client'
import { users, type Post, type User } from '../state/registry'

/** links: what this account can sign in with besides a guest key (from /api/me). */
export type MeLinks = { x: string | null; wallets: string[]; privy: boolean }
export type Me = ApiUser & { onboarded?: boolean; needsHandle?: boolean; renaming?: boolean; suggestedHandle?: string | null; links?: MeLinks }
/** How this session signed in (from /api/me). 'guest' = SIWE with this browser's guest key. Null = an older session. */
export type Login = { method: 'wallet' | 'guest'; address: string | null } | { method: 'x'; username: string } | { method: 'email' } | { method: 'privy' }
type ServerLogin = { method: 'wallet'; address: string | null } | { method: 'x'; username: string } | { method: 'email' } | { method: 'privy' }
type Session = {
  me: Me | null; ready: boolean; unread: number; login: Login | null
  /** while the session loads: this browser was signed in last time, so draw the signed-in shape (no layout shift) */
  expectMe: boolean
  signInGuest: () => Promise<Me>; signInWallet: (address?: `0x${string}`) => Promise<Me>; signInPrivy: () => Promise<Me>; signOut: () => Promise<void>
  /** Link X to the signed-in account (guests included). Resolves false when the window was closed; may leave the page for X. */
  linkX: () => Promise<boolean>
  /** Link a wallet to the signed-in account by signing a message with it. A guest account moves onto the wallet. */
  linkWallet: (address: `0x${string}`) => Promise<Me>
  refresh: () => void; setMe: (m: Me) => void; clearUnread: () => void
}
const Ctx = createContext<Session | null>(null)
const GUEST = 'wifly_guest_key'
const SIGNED = 'wifly_signed_in'
/** Set before an X login that is really a link (a guest or wallet account adding X). Read once Privy is back. */
const LINK_INTENT = 'wifly_link_intent'
const intent = {
  set: () => { try { sessionStorage.setItem(LINK_INTENT, String(Date.now())) } catch { /* storage off */ } },
  take: () => { try { const v = sessionStorage.getItem(LINK_INTENT); sessionStorage.removeItem(LINK_INTENT); return !!v && Date.now() - Number(v) < 15 * 60_000 } catch { return false } },
  has: () => { try { return !!sessionStorage.getItem(LINK_INTENT) } catch { return false } },
}
/** Privy's link errors in plain words. */
export function linkErrorText(e: unknown, kind: 'x' | 'wallet'): string {
  const m = String((e as Error)?.message ?? e ?? '')
  if (/linked_to_another_user|already.*(linked|belongs)|account_already_linked/i.test(m))
    return /wallet/i.test(m) || kind === 'wallet' ? 'that wallet already belongs to another wifly account' : 'that x account already belongs to another wifly account'
  if (/different x or email/i.test(m)) return 'this account already has a different x or email sign-in linked'
  return m.toLowerCase() || 'that didn’t go through'
}
function guestAddress(): string | null {
  try { const pk = localStorage.getItem(GUEST) as Hex | null; return pk ? privateKeyToAccount(pk).address.toLowerCase() : null } catch { return null }
}
const wasSignedIn = (() => { try { return localStorage.getItem(SIGNED) === '1' } catch { return false } })()

async function siweMessage(address: `0x${string}`, statement: string) {
  const { nonce } = await api<{ nonce: string }>('/auth/nonce')
  return createSiweMessage({ address, chainId: robinhoodChain.id, domain: location.host, uri: location.origin, nonce, version: '1', statement })
}
async function siwe(address: `0x${string}`, sign: (m: string) => Promise<Hex>): Promise<Me> {
  const message = await siweMessage(address, 'sign in to wifly. this is a signature, not a transaction: nothing is sent.')
  const signature = await sign(message)
  const r = await api<{ me: Me }>('/auth/verify', { method: 'POST', json: { message, signature, ...humanCheck() } }).finally(resetHumanCheck)
  // a wallet sign-in wins: drop any Privy (X/email) session left in this browser, so a reload can't swap accounts
  await privyBridge.logout().catch(() => {})
  return r.me
}
const linkPrivy = async (t: PrivyTokens) => (await api<{ me: Me }>('/auth/link/privy', { method: 'POST', json: t })).me

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['me'], queryFn: () => api<{ me: Me | null; unread?: number; login?: ServerLogin | null }>('/me'), refetchInterval: 30_000, retry: false })
  const [override, setOverride] = useState<Me | null | undefined>(undefined)
  const me = override !== undefined ? override : q.data?.me ?? null
  useEffect(() => { if (q.data?.me) setOverride(undefined) }, [q.data])
  useEffect(() => { if (me && me.handle) adoptUser({ ...me, you: true }) }, [me])
  useEffect(() => {
    if (q.isLoading) return
    try { if (me) localStorage.setItem(SIGNED, '1'); else localStorage.removeItem(SIGNED) } catch { /* storage off */ }
  }, [me, q.isLoading])
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()

  const after = useCallback((m: Me) => { setOverride(m); qc.invalidateQueries() ; return m }, [qc])
  const signInGuest = useCallback(async () => {
    let pk = localStorage.getItem(GUEST) as Hex | null
    if (!pk) { pk = generatePrivateKey(); localStorage.setItem(GUEST, pk) }
    const acct = privateKeyToAccount(pk)
    const m = await siwe(acct.address, x => acct.signMessage({ message: x })); via.current = 'wallet'; return after(m)
  }, [after])
  // the address comes in from the caller right after connecting: the hook's own value is still the old render's
  const signInWallet = useCallback(async (addr?: `0x${string}`) => {
    const a = addr ?? address
    if (!a) throw new Error('connect a wallet first')
    const m = await siwe(a, x => signMessageAsync({ message: x, account: a })); via.current = 'wallet'; return after(m)
  }, [address, signMessageAsync, after])
  const exchange = useCallback(async (t: PrivyTokens) =>
    (await api<{ me: Me }>('/auth/privy', { method: 'POST', json: { ...t, ...humanCheck() } }).finally(resetHumanCheck)).me, [])
  const signInPrivy = useCallback(async () => {
    privyLogin.current = true
    try { const m = await exchange(await privyBridge.login()); via.current = 'privy'; return after(m) } finally { privyLogin.current = false }
  }, [exchange, after])
  // Privy finishes creating the embedded wallet a moment after login, and restores its own session on reload:
  // whenever its identity token changes, hand the fresh one to the server so the account and wallet stay in sync.
  const lastTok = useRef<string | null>(null)
  // Only restore a Privy session when this browser isn't already signed in another way: a session that started with a
  // wallet (or guest key) clears the leftover Privy session instead of exchanging it (that used to switch accounts on reload).
  // 'wallet' | 'privy' | null: what the current session is, from /api/me, updated at once by a sign-in on this page
  const via = useRef<'wallet' | 'privy' | null>(null)
  const privyLogin = useRef(false) // an X/email sign-in is in flight: let it finish
  const seen = useRef<unknown>(null)
  if (q.data && q.data !== seen.current) { seen.current = q.data; via.current = !q.data.me ? null : q.data.login?.method === 'wallet' ? 'wallet' : q.data.login ? 'privy' : via.current }
  const syncPrivy = useCallback(() => {
    if (!privyEnabled) return
    const st = privyBridge.get()
    if (!st.ready || !st.authenticated || q.isLoading || privyLogin.current) return
    // back from X after "link x" on a guest or wallet account: add X to that account instead of switching to another one
    if (q.data?.me && intent.has()) {
      intent.take(); privyLogin.current = true
      privyBridge.tokens().then(linkPrivy).then(m => { via.current = 'privy'; after(m); window.dispatchEvent(new CustomEvent('wifly:linked', { detail: { kind: 'x' } })) })
        .catch(e => { console.error('[link] x after return:', e); window.dispatchEvent(new CustomEvent('wifly:link-error', { detail: { kind: 'x', message: linkErrorText(e, 'x') } })); void privyBridge.logout() })
        .finally(() => { privyLogin.current = false })
      return
    }
    if (via.current === 'wallet') { lastTok.current = null; void privyBridge.logout(); return }
    // the identity token can lag (or be off in the dashboard): with none yet, exchange once with the access token
    const key = st.identityToken ?? 'access'
    if (key === lastTok.current) return
    lastTok.current = key
    const t: Promise<PrivyTokens> = st.identityToken ? Promise.resolve({ identityToken: st.identityToken }) : privyBridge.tokens()
    t.then(exchange).then(m => { via.current = 'privy'; setOverride(m); qc.invalidateQueries({ queryKey: ['me'] }) })
      .catch(e => console.error('[sign-in] restoring the privy session failed:', e))
  }, [exchange, qc, q.isLoading, q.data, after])
  useEffect(() => (privyEnabled ? privyBridge.subscribe(syncPrivy) : undefined), [syncPrivy])
  useEffect(() => { syncPrivy() }, [syncPrivy, q.isLoading, q.data])
  // A signed-in account that isn't this browser's guest key or the connected wallet may sign through Privy:
  // load Privy once the page is idle so its wallet is ready (guests and wallet users never download it).
  useEffect(() => {
    if (!privyEnabled || !me?.address) return
    const mine = me.address.toLowerCase()
    if (address && address.toLowerCase() === mine) return
    try { const pk = localStorage.getItem(GUEST) as Hex | null; if (pk && privateKeyToAccount(pk).address.toLowerCase() === mine) return } catch { /* ignore */ }
    const w = window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }
    if (w.requestIdleCallback) w.requestIdleCallback(wantPrivy, { timeout: 4000 }); else setTimeout(wantPrivy, 1500)
  }, [me?.address, address])
  const linkX = useCallback(async () => {
    if (!privyEnabled) throw new Error('x sign-in isn’t set up here yet')
    privyLogin.current = true
    try {
      // an X or email account already has a Privy session: link X onto it
      if (via.current === 'privy' && (await privyBridge.linkReady()) === 'ready') {
        if (!(await privyBridge.linkAsync('twitter'))) return false
        after(await linkPrivy(await privyBridge.tokens())); return true
      }
      // a guest or wallet account has no Privy session: sign in with X (a redirect), then link on the way back
      intent.set()
      await privyBridge.login(['twitter'])
      intent.take()
      after(await linkPrivy(await privyBridge.tokens())); via.current = 'privy'; return true
    } catch (e) {
      intent.take()
      if (/closed|exited/i.test(String((e as Error)?.message))) return false
      console.error('[link] x:', e)
      if (via.current !== 'privy') void privyBridge.logout()
      throw new Error(linkErrorText(e, 'x'))
    } finally { privyLogin.current = false }
  }, [after])
  const linkWallet = useCallback(async (addr: `0x${string}`) => {
    const message = await siweMessage(addr, 'link this wallet to your wifly account. this is a signature, not a transaction: nothing is sent.')
    const signature = await signMessageAsync({ message, account: addr })
    const guest = guestAddress() !== null && (q.data?.me?.address ?? '').toLowerCase() === guestAddress()
    try { const r = await api<{ me: Me }>('/auth/link/wallet', { method: 'POST', json: { message, signature, guest } }); via.current = 'wallet'; return after(r.me) }
    catch (e) { throw new Error(linkErrorText(e, 'wallet')) }
  }, [signMessageAsync, after, q.data])
  const signOut = useCallback(async () => {
    lastTok.current = null; via.current = null
    await privyBridge.logout()
    await api('/auth/logout', { method: 'POST' })
    delete users.you
    setOverride(null); qc.invalidateQueries()
  }, [qc])

  const sl = q.data?.login ?? null
  const login: Login | null = !me || !sl ? null
    : sl.method === 'wallet' && sl.address && sl.address.toLowerCase() === guestAddress() ? { method: 'guest', address: sl.address } : sl
  const value = useMemo<Session>(() => ({
    me, login, ready: !q.isLoading, expectMe: q.isLoading && wasSignedIn, unread: me ? q.data?.unread ?? 0 : 0,
    signInGuest, signInWallet, signInPrivy, signOut, linkX, linkWallet, refresh: () => { q.refetch() }, setMe: m => setOverride(m),
    clearUnread: () => qc.setQueryData(['me'], (d: { me: Me | null; unread?: number } | undefined) => d ? { ...d, unread: 0 } : d),
  }), [me, login, q, signInGuest, signInWallet, signInPrivy, signOut, linkX, linkWallet, qc])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession() {
  const s = useContext(Ctx)
  if (!s) throw new Error('useSession outside SessionProvider')
  return s
}

/** Re-render when any api user or drop changes. */
export function useRegistry() { return useSyncExternalStore(subscribe, getVersion) }

/** The freshest copy of a drop (optimistic overlay included), falling back to the prop. */
export function useLive(p: Post): Post { useRegistry(); return getDrop(p.id) ?? p }
export function useUser(handle: string): User | undefined { useRegistry(); return users[handle] }
