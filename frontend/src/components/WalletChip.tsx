import { useEffect, useRef, useState } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { LINKS, robinhoodChain } from '../config'
import { useWifBalance } from '../lib/chain'
import { shortAddr } from '../lib/format'
import { Token } from './Bits'
import { useStore } from '../state/store'
import { Icon } from './Icon'
import { useSession } from '../api/session'
import { useAnyAccount } from '../auth/privyBridge'

export function WalletChip({ compact = false }: { compact?: boolean }) {
  const { address: wagmiAddr, isConnected: wagmiOn, chainId } = useAccount()
  const { me } = useSession()
  const any = useAnyAccount().address
  // signed in counts as connected: the header follows the wifly session (guest key, wallet or Privy), not only wagmi
  const address = (wagmiAddr ?? any ?? (me?.address || undefined)) as `0x${string}` | undefined
  const isConnected = !!address
  const { connect, connectors, isPending, error } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const bal = useWifBalance(address)
  const [open, setOpen] = useState(false)
  const { openSheet } = useStore()
  const ref = useRef<HTMLDivElement>(null)
  const wrongChain = wagmiOn && chainId !== robinhoodChain.id

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const hasInjected = typeof window !== 'undefined' && 'ethereum' in window
  const balanceText = bal.value === undefined ? '—' : bal.value.toLocaleString('en-US', { maximumFractionDigits: bal.value >= 100 ? 0 : 2 })

  if (me && !address) return null
  return (
    <div className="wallet" ref={ref}>
      <button className={`wallet-chip ${isConnected ? 'is-on' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <Token size={20} />
        {isConnected ? (
          <>
            <span className="num">{balanceText}</span>
            <span className="wallet-chip__unit">WIF</span>
          </>
        ) : (
          <span>{compact ? 'connect' : 'connect wallet'}</span>
        )}
      </button>
      {open && (
        <div className="wallet-pop" role="dialog" aria-label="Wallet">
          {isConnected ? (
            <>
              <div className="wallet-pop__row">
                <span className="eyebrow">{wagmiOn ? 'connected' : 'signed in'}</span>
                <span className="mono">{shortAddr(address)}</span>
              </div>
              <div className="wallet-pop__balance">
                <Token size={32} />
                <div>
                  <div className="display-num">{balanceText}</div>
                  <div className="muted small">WIF balance · live</div>
                </div>
              </div>
              {wrongChain && (
                <button className="btn btn--dark btn--block" onClick={() => switchChain({ chainId: robinhoodChain.id })}>switch network</button>
              )}
              <div className="wallet-pop__actions">
                <button className="btn btn--dark" onClick={() => { setOpen(false); openSheet({ type: 'swap' }) }}><Token size={16} /> get $WIF</button>
                {wagmiOn && <button className="btn btn--ghost" onClick={() => { disconnect(); setOpen(false) }}>disconnect</button>}
              </div>
            </>
          ) : (
            <>
              <div className="eyebrow">read only</div>
              <p className="small">connect to see your WIF balance. connecting only reads it.</p>
              {hasInjected ? (
                connectors.map(c => (
                  <button key={c.uid} className="btn btn--dark btn--block" disabled={isPending} onClick={() => connect({ connector: c, chainId: robinhoodChain.id })}>
                    <Icon name="wallet" size={18} /> {isPending ? 'connecting…' : `connect ${c.name === 'Injected' ? 'browser wallet' : c.name}`}
                  </button>
                ))
              ) : (
                <p className="muted small">no browser wallet found. install one to read your balance.</p>
              )}
              {error && <p className="small error">{error.message.split('\n')[0]}</p>}
              <button className="btn btn--ghost btn--block" onClick={() => { setOpen(false); openSheet({ type: 'swap' }) }}><Token size={16} /> get $WIF with ETH</button>
              <a className="small muted wallet-pop__alt" href={LINKS.buy} target="_blank" rel="noreferrer"><img src="/brand/pons-96.png" width={16} height={16} alt="" /> or trade on Pons</a>
            </>
          )}
        </div>
      )}
    </div>
  )
}
