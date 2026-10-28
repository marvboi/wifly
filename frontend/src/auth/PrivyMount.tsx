/**
 * Lazy Privy chunk: X, email or wallet login. Smart wallets are OFF: users who sign in without a wallet get a Privy
 * embedded EVM wallet (createOnLogin 'users-without-wallets'); Robinhood Chain (4663) is the default and only chain.
 * It renders nothing itself; it only syncs Privy's state into privyBridge.
 */
import { useEffect, useRef } from 'react'
import { PrivyProvider, useIdentityToken, useLinkAccount, useLogin, useLogout, usePrivy, useWallets, getIdentityToken, type WalletListEntry } from '@privy-io/react-auth'
import { robinhoodChain } from '../config'
import { PRIVY_APP_ID, privyBridge } from './privyBridge'

function Sync() {
  const { ready, authenticated, user, getAccessToken, exportWallet } = usePrivy()
  const { identityToken } = useIdentityToken()
  const { logout } = useLogout()
  const linking = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null)
  const { linkTwitter, linkWallet } = useLinkAccount({
    onSuccess: () => { linking.current?.resolve(); linking.current = null },
    onError: err => { console.error('[link] privy error:', err); linking.current?.reject(new Error(String(err))); linking.current = null },
  })
  const startLink = (fn: () => void) => new Promise<void>((resolve, reject) => { linking.current?.reject(new Error('exited_link_flow')); linking.current = { resolve, reject }; try { fn() } catch (e) { linking.current = null; reject(e as Error) } })
  const { wallets } = useWallets()
  // Embedded (X/email) and external (MetaMask, Rabby, WalletConnect) wallets are treated the same: the first
  // connected one signs. Privy lists the most recently connected wallet first.
  const active = wallets[0] ?? null
  const activeRef = useRef(active)
  activeRef.current = active
  const walletsRef = useRef(wallets)
  walletsRef.current = wallets
  const walletOf = (a: string) => walletsRef.current.find(w => w.address.toLowerCase() === a.toLowerCase())
  const pending = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null)
  const { login } = useLogin({
    onComplete: () => { pending.current?.resolve(); pending.current = null },
    onError: err => { if (err !== 'exited_auth_flow') console.error('[sign-in] privy error:', err); pending.current?.reject(new Error(err === 'exited_auth_flow' ? 'sign-in closed' : `sign-in failed (${err})`)); pending.current = null },
  })

  useEffect(() => {
    privyBridge.register({
      login: methods => new Promise<void>((resolve, reject) => { pending.current = { resolve, reject }; login(methods ? { loginMethods: methods } : undefined) }),
      logout,
      getIdentityToken: () => getIdentityToken(),
      getAccessToken: () => getAccessToken(),
      linkTwitter: () => startLink(() => linkTwitter()),
      linkWallet: () => startLink(() => linkWallet()),
      sendTxFrom: async (from, to, data, chainId, value) => {
        const w = walletOf(from)
        if (!w) throw new Error('sign in with x or email to use this wallet')
        await w.switchChain(chainId)
        const p = await w.getEthereumProvider()
        return await p.request({ method: 'eth_sendTransaction', params: [{ from: w.address, to, data, ...(value ? { value: `0x${value.toString(16)}` } : {}) }] }) as `0x${string}`
      },
      signMessageFrom: async (from, message) => {
        const w = walletOf(from)
        if (!w) throw new Error('sign in with x or email to use this wallet')
        const p = await w.getEthereumProvider()
        return await p.request({ method: 'personal_sign', params: [message, w.address] }) as `0x${string}`
      },
      exportWallet: address => exportWallet({ address }),
      sendTx: async (to, data, chainId, value) => {
        const w = activeRef.current
        if (!w) throw new Error('connect a wallet first')
        await w.switchChain(chainId)
        const p = await w.getEthereumProvider()
        return await p.request({ method: 'eth_sendTransaction', params: [{ from: w.address, to, data, ...(value ? { value: `0x${value.toString(16)}` } : {}) }] }) as `0x${string}`
      },
    })
  }, [login, logout, linkTwitter, linkWallet, getAccessToken, exportWallet])

  useEffect(() => {
    const smart = null // smart wallets are off in this app
    const embedded = user?.linkedAccounts.find(a => a.type === 'wallet' && a.walletClientType === 'privy')
    const x = user?.twitter?.username ?? null
    const ext = user?.linkedAccounts.find(a => a.type === 'wallet' && a.walletClientType !== 'privy' && a.walletClientType !== 'privy-v2')
    privyBridge.set({
      xUsername: x, linkedWallet: ext && 'address' in ext ? String(ext.address).toLowerCase() : null,
      activeWallet: active ? active.address.toLowerCase() : null,
      wallets: wallets.map(w => w.address.toLowerCase()).join(','),
      loaded: true, ready, authenticated, identityToken: identityToken ?? null, smartWallet: smart,
      embeddedWallet: embedded && 'address' in embedded ? String(embedded.address).toLowerCase() : null,
    })
  }, [ready, authenticated, user, identityToken, active, wallets])
  return null
}

const WC_PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '').trim()
// Rabby and other browser wallets show up through EIP-6963 detection (Privy dropped the separate rabby_wallet entry).
const WALLETS: WalletListEntry[] = ['detected_ethereum_wallets', 'metamask', ...(WC_PROJECT_ID ? ['wallet_connect' as const] : [])]

export default function PrivyMount() {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['twitter', 'email', 'wallet'],
        appearance: { theme: 'light', accentColor: '#111111', landingHeader: 'the world is fair', showWalletLoginFirst: false, walletList: WALLETS },
        ...(WC_PROJECT_ID ? { walletConnectCloudProjectId: WC_PROJECT_ID } : {}),
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' }, showWalletUIs: false },
        defaultChain: robinhoodChain,
        supportedChains: [robinhoodChain],
      }}
    >
      <Sync />
    </PrivyProvider>
  )
}
