import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { LINKS, robinhoodChain } from '../config'
import { useWifBalance } from '../lib/chain'
import { shortAddr } from '../lib/format'
import { Token } from './Bits'
import { useStore } from '../state/store'
import { Icon } from './Icon'
import { useSession } from '../api/session'
import { privyBridge, privyEnabled, useAnyAccount, wantPrivy } from '../auth/privyBridge'
import { OPEN_WALLET_EVENT, usePayerState } from '../lib/payerStore'
import { WalletMenuPayer } from './Payer'
import { placeWalletPop } from './walletPop'

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
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number; up: boolean; width: number } | null>(null)
  const wrongChain = wagmiOn && chainId !== robinhoodChain.id
  // 11.8.5: with an account wallet list, the menu shows the paying wallet and every wallet on the account
  const payer = usePayerState()
  const hasPayer = !!payer.address && payer.options.length > 0
  useEffect(() => {
    const open = () => setOpen(true)
    window.addEventListener(OPEN_WALLET_EVENT, open)
    return () => window.removeEventListener(OPEN_WALLET_EVENT, open)
  }, [])

  const place = useCallback(() => {
    const a = (ref.current?.querySelector('.wallet-chip') as HTMLElement | null)?.getBoundingClientRect()
    const m = popRef.current
    if (!a || !m) return
    const dock = document.querySelector('.dock')?.getBoundingClientRect()
    const join = document.querySelector('.joinbar')?.getBoundingClientRect()
    const vh = window.innerHeight
    const floor = Math.min(dock && dock.top < vh ? dock.top : vh, join && join.top < vh ? join.top : vh, vh)
    setPos(placeWalletPop(a, { width: m.offsetWidth, height: m.scrollHeight }, { w: window.innerWidth, h: vh, floor }))
  }, [])
  useLayoutEffect(() => { if (open) place(); else setPos(null) }, [open, place])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!popRef.current?.contains(t) && !ref.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place])

  const hasInjected = typeof window !== 'undefined' && 'ethereum' in window
  const balanceText = bal.value === undefined ? '—' : bal.value.toLocaleString('en-US', { maximumFractionDigits: bal.value >= 100 ? 0 : 2 })

  if (me && !address) return null

  const body: ReactNode = isConnected && hasPayer ? (
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
      {privyEnabled ? (
        <button type="button" className="btn btn--dark btn--block" data-testid="wallet-connect-privy" onClick={() => { wantPrivy(); void privyBridge.connectExternal().catch(() => {}) }}>
          <Icon name="wallet" size={18} /> connect wallet
        </button>
      ) : hasInjected ? (
        connectors.filter(c => (c.id ?? c.type ?? '').toLowerCase() === 'injected').map(c => (
          <button key={c.uid} className="btn btn--dark btn--block" disabled={isPending} onClick={() => connect({ connector: c, chainId: robinhoodChain.id })}>
            <Icon name="wallet" size={18} /> {isPending ? 'connecting…' : 'connect browser wallet'}
          </button>
        ))
      ) : (
        <p className="muted small">no browser wallet found. install one to read your balance.</p>
      )}
      {error && <p className="small error wallet-pop__err">{/reject|denied/i.test(error.message) ? 'cancelled' : 'couldn’t connect. try again in a moment'}</p>}
      <button className="btn btn--ghost btn--block" onClick={() => { setOpen(false); openSheet({ type: 'swap' }) }}><Token size={16} /> get $wif with eth</button>
      <a className="small muted wallet-pop__alt" href={LINKS.buy} target="_blank" rel="noreferrer"><img src="/brand/pons-96.png" width={16} height={16} alt="" /> or trade on pons</a>
    </>
  )

  const pop = typeof document !== 'undefined' ? createPortal(
    <AnimatePresence>
      {open && (
        <motion.div ref={popRef} className={`wallet-pop wallet-pop--float ${isConnected && hasPayer ? 'wallet-pop--pro' : ''} ${pos?.up ? 'is-up' : ''}`} role="dialog" aria-label="wallet"
          data-testid="wallet-pop"
          initial={{ opacity: 0, y: pos?.up ? 6 : -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: pos?.up ? 4 : -4, scale: 0.98 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          style={{
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            maxHeight: pos?.maxH,
            width: pos?.width,
            visibility: pos ? 'visible' : 'hidden',
            transformOrigin: pos?.up ? 'bottom right' : 'top right',
          }}>
          {body}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  ) : null

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
      {pop}
    </div>
  )
}
