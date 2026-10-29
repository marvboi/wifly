import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { LINKS, robinhoodChain } from '../config'
import { useWifBalance } from '../lib/chain'
import { shortAddr } from '../lib/format'
import { Token } from './Bits'
import { useStore } from '../state/store'
import { Icon } from './Icon'
import { useSession } from '../api/session'
import { useAnyAccount } from '../auth/privyBridge'
import { OPEN_WALLET_EVENT, usePayerState } from '../lib/payerStore'
import { WalletMenuPayer } from './Payer'

export function WalletChip({ compact = false }: { compact?: boolean }) {
  const { address: wagmiAddr, isConnected: wagmiOn, chainId } = useAccount()
  const { me } = useSession()
  const any = useAnyAccount().address
  // signed in counts as connected: the header follows the wifly session (guest key, wallet or Privy), not only wagmi
  const address = (any ?? wagmiAddr ?? (me?.address || undefined)) as `0x${string}` | undefined // the paying wallet leads (useAnyAccount follows the pick)
  const isConnected = !!address
  const { connect, connectors, isPending, error } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const bal = useWifBalance(address)
  const [open, setOpen] = useState(false)
  const { openSheet } = useStore()
  const ref = useRef<HTMLDivElement>(null)
  const wrongChain = wagmiOn && chainId !== robinhoodChain.id
  // 11.8.5: with an account wallet list, the menu shows the paying wallet and every wallet on the account
  const payer = usePayerState()
  const hasPayer = !!payer.address && payer.options.length > 0
  useEffect(() => {
    const open = () => setOpen(true)
    window.addEventListener(OPEN_WALLET_EVENT, open)
    return () => window.removeEventListener(OPEN_WALLET_EVENT, open)
  }, [])

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
            <span className="wallet-chip__unit">wif</span>
          </>
        ) : (
          <span>{compact ? 'connect' : 'connect wallet'}</span>
        )}
      </button>
      <AnimatePresence>
      {open && (
        <motion.div className={`wallet-pop ${isConnected && hasPayer ? 'wallet-pop--pro' : ''}`} role="dialog" aria-label="wallet"
          initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} style={{ transformOrigin: 'top right' }}>
          {isConnected && hasPayer ? (
            <>
              <WalletMenuPayer />
              <div className="wm-actions">
                {wrongChain && (
                  <button className="btn btn--ghost btn--block" onClick={() => switchChain({ chainId: robinhoodChain.id })}>switch network</button>
                )}
                <button className="btn btn--dark btn--block wm-primary" data-testid="wm-get" onClick={() => { setOpen(false); openSheet({ type: 'swap' }) }}><Token size={18} /> get $wif</button>
                {wagmiOn && <button type="button" className="wm-quiet" data-testid="wm-disconnect" onClick={() => { disconnect(); setOpen(false) }}><Icon name="power" size={13} /> disconnect</button>}
              </div>
            </>
          ) : isConnected ? (
            <>
              <div className="wallet-pop__row">
                <span className="eyebrow">{wagmiOn ? 'connected' : 'signed in'}</span>
                <span className="mono">{shortAddr(address)}</span>
              </div>
              <div className="wallet-pop__balance">
                <Token size={32} />
                <div>
                  <div className="display-num">{balanceText}</div>
                  <div className="muted small">wif in this wallet · live</div>
                </div>
              </div>
              {wrongChain && (
                <button className="btn btn--dark btn--block" onClick={() => switchChain({ chainId: robinhoodChain.id })}>switch network</button>
              )}
              <div className="wallet-pop__actions">
                <button className="btn btn--dark" onClick={() => { setOpen(false); openSheet({ type: 'swap' }) }}><Token size={16} /> get $wif</button>
                {wagmiOn && <button type="button" className="wm-quiet" onClick={() => { disconnect(); setOpen(false) }}>disconnect</button>}
              </div>
            </>
          ) : (
            <>
              <div className="eyebrow">read only</div>
              <p className="small">connect to see your wif balance. connecting only reads it.</p>
              {hasInjected ? (
                connectors.map(c => (
                  <button key={c.uid} className="btn btn--dark btn--block" disabled={isPending} onClick={() => connect({ connector: c, chainId: robinhoodChain.id })}>
                    <Icon name="wallet" size={18} /> {isPending ? 'connecting…' : `connect ${c.name === 'Injected' ? 'browser wallet' : c.name}`}
                  </button>
                ))
              ) : (
                <p className="muted small">no browser wallet found. install one to read your balance.</p>
              )}
              {error && <p className="small error wallet-pop__err">{/reject|denied/i.test(error.message) ? 'cancelled' : 'couldn’t connect. try again in a moment'}</p>}
              <button className="btn btn--ghost btn--block" onClick={() => { setOpen(false); openSheet({ type: 'swap' }) }}><Token size={16} /> get $wif with eth</button>
              <a className="small muted wallet-pop__alt" href={LINKS.buy} target="_blank" rel="noreferrer"><img src="/brand/pons-96.png" width={16} height={16} alt="" /> or trade on pons</a>
            </>
          )}
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  )
}
