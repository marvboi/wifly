/**
 * 11.8.5: the wallet that pays, site-wide. PayerSync works out the options (wallets already on this account: linked
 * external wallets and the privy embedded one) and the pick (saved per account, else a sensible default). The wallet
 * menu lets the user switch; a linked external wallet that isn't connected here connects that exact address through
 * privy (connect only, never link). "paying from" rows in the companion and every tx spot read the same pick.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useQuery } from '@tanstack/react-query'
import { useAccount, useConnect, useDisconnect, usePublicClient } from 'wagmi'
import { erc20Abi, type Address } from 'viem'
import { useSession } from '../api/session'
import { privyBridge, privyEnabled, usePrivyState } from '../auth/privyBridge'
import { robinhoodChain, WIF_TOKEN } from '../config'
import { EMBEDDED_FUND_LINE, PAYER_GAS_LINE, addrLabel, avatarColors, defaultPayer, fmtUnits, gasChip, linkedButton, payerOptions, payerTag, shortA, showEmbeddedFundLine, wifNumber, wifUsd, type PayerOption } from '../lib/payer'
import { openWalletMenu, payerStore, usePayerState } from '../lib/payerStore'
import { Icon } from './Icon'
import { useWifPrice, Usd } from '../lib/price'
import { hasInjectedProvider, injectedConnector } from '../lib/walletOpen'

type Bal = { eth: bigint; wif: bigint }

/** eth + wif per wallet (same cache key as the wallets section, so both stay in step). */
export function usePayerBalances(addresses: string[]) {
  const client = usePublicClient({ chainId: robinhoodChain.id })
  return useQuery({
    queryKey: ['balances', addresses.join(',')],
    enabled: !!client && addresses.length > 0,
    refetchInterval: 30_000,
    queryFn: async () => {
      const out: Record<string, Bal> = {}
      await Promise.all(addresses.map(async a => {
        const [eth, wif] = await Promise.all([
          client!.getBalance({ address: a as Address }).catch(() => 0n),
          client!.readContract({ address: WIF_TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [a as Address] }).catch(() => 0n),
        ])
        out[a] = { eth, wif: wif as bigint }
      }))
      return out
    },
  })
}

/** Mounted once: keeps the app-wide payer in step with the account, privy and wagmi. */
export function PayerSync() {
  const { me } = useSession()
  const privy = usePrivyState()
  const { address: wagmi } = useAccount()
  const user = me && !me.guest ? (me.address || me.handle || null) : null
  const list = useMemo(() => me?.links?.walletList ?? [], [me?.links?.walletList])
  const signable = privy.authenticated ? privy.wallets.split(',').filter(Boolean) : []
  const options = useMemo(() => payerOptions(list, { signable, wagmi }), [list, signable.join(','), wagmi]) // eslint-disable-line react-hooks/exhaustive-deps
  const bal = usePayerBalances(options.map(o => o.address))
  useEffect(() => {
    if (!user) { payerStore.set({ user: null, options: [], address: null }); return }
    const address = defaultPayer(options, bal.data ?? {}, payerStore.saved(String(user)))
    payerStore.set({ user: String(user), options, address })
  }, [user, options, bal.data])
  return null
}

/** Switch to a wallet: ready ones switch at once; a linked one that isn't connected connects that exact address first. */
export function usePayerSwitch() {
  const { connectAsync, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const use = async (o: PayerOption) => {
    setErr(null)
    if (o.ready) { payerStore.choose(o.address); return }
    if (o.kind === 'embedded') { setErr('sign in with the x or email login that made this wallet to use it'); return }
    setBusy(o.address)
    try {
      let got: 'ok' | 'other' | 'closed'
      if (privyEnabled) got = await privyBridge.connectExact(o.address)
      else {
        if (hasInjectedProvider() === false) { setErr('no browser wallet found here'); return }
        const c = injectedConnector(connectors)
        if (!c) { setErr('no browser wallet found here'); return }
        const r = await connectAsync({ connector: c, chainId: robinhoodChain.id })
        got = r.accounts.some(a => a.toLowerCase() === o.address) ? 'ok' : 'other'
        if (got === 'other') disconnect()
      }
      if (got === 'ok') payerStore.choose(o.address)
      else if (got === 'other') setErr(`that's a different wallet. switch your wallet app to ${shortA(o.address)} and try again`)
    } catch (e) {
      const m = (e as Error).message ?? ''
      setErr(/reject|denied|closed/i.test(m) ? null : 'couldn’t connect that wallet. try again in a moment')
      if (!/reject|denied|closed/i.test(m)) console.warn('[wifly] connect wallet', e)
    } finally { setBusy(null) }
  }
  return { use, busy, err }
}

export function CopyAddr({ address, label = 'copy wallet address', iconOnly = false }: { address: string; label?: string; iconOnly?: boolean }) {
  const [done, setDone] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(t.current), [])
  const copy = () => { void navigator.clipboard?.writeText(address).catch(() => {}); setDone(true); clearTimeout(t.current); t.current = setTimeout(() => setDone(false), 1400) }
  return (
    <button type="button" className={`payer__copy ${iconOnly ? 'payer__copy--icon' : ''} ${done ? 'is-done' : ''}`} aria-label={done ? 'copied' : label} title={done ? 'copied' : label} onClick={copy}>
      <Icon name={done ? 'check' : 'copy'} size={iconOnly ? 14 : 12} />{(!iconOnly || done) && <span aria-live="polite">{done ? 'copied' : 'copy'}</span>}
    </button>
  )
}

/** 11.8.6: a small gradient dot, stable per address. */
export function WalletAvatar({ address, size = 28 }: { address: string; size?: number }) {
  const [a, b] = avatarColors(address)
  return <span className="wav" aria-hidden="true" style={{ width: size, height: size, background: `radial-gradient(circle at 30% 28%, rgba(255,255,255,.55), transparent 42%), linear-gradient(135deg, ${a}, ${b})` }} />
}
export const KindPill = ({ kind }: { kind: PayerOption['kind'] }) => <span className={`kpill kpill--${kind}`}>{payerTag(kind)}</span>
const GasPill = ({ eth }: { eth: bigint | undefined }) => {
  const g = gasChip(eth)
  return <span className={`gaspill gaspill--${g.tone}`} data-testid="gas-pill" data-tone={g.tone}><span className="gaspill__dot" />{g.label}</span>
}

/**
 * The gas note: one short line plus the address and copy. Linked + empty: PAYER_GAS_LINE; embedded
 * gets EMBEDDED_FUND_LINE only when its eth is known and below LOW_GAS_WEI (same rule as the gas chip).
 */
export function PayerGas({ o, empty = true, eth }: { o: PayerOption; empty?: boolean; eth?: bigint }) {
  const fundEmbedded = o.kind === 'embedded' && showEmbeddedFundLine(eth)
  return (
    <div className="payer__gas" role="note" data-testid={empty ? 'payer-gas' : 'payer-fund'}>
      {empty && o.kind !== 'embedded' && <p className="small">{PAYER_GAS_LINE}</p>}
      {fundEmbedded && <p className="small" data-testid="embedded-fund">{EMBEDDED_FUND_LINE}</p>}
      <p className="tiny muted payer__gasaddr"><code className="mono" title={o.address}>{addrLabel(o.address)}</code><CopyAddr address={o.address} /></p>
    </div>
  )
}

/**
 * One compact row: "paying from 0x25bb…d5d7 [linked] · copy · switch", balances on a small second line, then the gas
 * note when it has none (or when an embedded wallet is low on gas), and the linked-wallet shortcut. "switch" opens the top wallet menu,
 * where the choice lives. Renders nothing when there's no account wallet list. Reads well on light and dark cards.
 */
export function PayingFrom({ className = '' }: { className?: string }) {
  const ps = usePayerState()
  const o = ps.options.find(x => x.address === ps.address) ?? null
  const bal = usePayerBalances(ps.options.map(x => x.address))
  const sw = usePayerSwitch()
  if (!o) return null
  const b = bal.data?.[o.address]
  const noGas = b !== undefined && b.eth === 0n
  const others = ps.options.filter(x => x.address !== o.address)
  const linked = others.find(x => x.kind === 'linked')
  return (
    <div className={`payer ${className}`} data-testid="paying-from">
      <div className="payer__row">
        <span className="payer__who small">
          <span className="payer__lbl"><span className="payer__lbl-pre">paying </span>from</span>
          <code className="mono payer__addr" title={o.address} data-testid="payer-addr">{addrLabel(o.address)}</code>
          <KindPill kind={o.kind} />
        </span>
        <span className="payer__acts">
          <CopyAddr address={o.address} iconOnly />
          {others.length > 0 && <button type="button" className="payer__switch" data-testid="payer-switch" onClick={openWalletMenu}>switch</button>}
        </span>
      </div>
      <p className="payer__bal tiny num" data-testid="payer-bal">{fmtUnits(b?.eth, 'eth')} · {fmtUnits(b?.wif, 'wif')} <span>in this wallet</span></p>
      {!o.ready && o.kind === 'linked' && (
        <button type="button" className="btn btn--ghost btn--sm payer__connect" disabled={sw.busy === o.address} onClick={() => void sw.use(o)}>{sw.busy === o.address ? 'connecting…' : `connect ${shortA(o.address)}`}</button>
      )}
      {(noGas || showEmbeddedFundLine(o.kind === 'embedded' ? b?.eth : undefined)) && <PayerGas o={o} empty={noGas} eth={b?.eth} />}
      {linked && o.kind === 'embedded' && (
        <div className="payer__links">
          <button type="button" className="linkbtn" disabled={sw.busy === linked.address} onClick={() => void sw.use(linked)}>{sw.busy === linked.address ? 'connecting…' : linkedButton(linked.address)}</button>
        </div>
      )}
      {sw.err && <p className="tiny payer__err">{sw.err}</p>}
    </div>
  )
}

/**
 * 11.8.6 wallet menu: a header for the paying wallet (avatar, address, pill, copy; big wif with ≈ $; a gas pill that
 * goes amber "add eth" at 0), then every wallet on the account as a tappable row with a lime check on the active one
 * (a linked wallet that isn't connected here shows "connect"). Thin dividers, no boxes.
 */
export function WalletMenuPayer() {
  const ps = usePayerState()
  const bal = usePayerBalances(ps.options.map(x => x.address))
  const sw = usePayerSwitch()
  const { usd } = useWifPrice()
  const o = ps.options.find(x => x.address === ps.address) ?? null
  if (!o) return null
  const b = bal.data?.[o.address]
  const gasNote = b?.eth === 0n || (o.kind === 'embedded' && showEmbeddedFundLine(b?.eth))
  return (
    <div className="payer payer--menu" data-testid="wallet-payer">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={o.address} className="wm-head" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
          <div className="eyebrow">paying from</div>
          <div className="wm-id">
            <WalletAvatar address={o.address} size={32} />
            <code className="mono wm-id__addr" title={o.address} data-testid="wm-addr">{addrLabel(o.address)}</code>
            <KindPill kind={o.kind} />
            <CopyAddr address={o.address} iconOnly />
          </div>
          <div className="wm-bal">
            <span className="wm-bal__num num" data-testid="payer-wif">{wifNumber(b?.wif)}</span><span className="wm-bal__unit">wif</span>
          </div>
          <div className="wm-sub">
            <Usd value={wifUsd(b?.wif, usd)} className="wm-usd" />
            <GasPill eth={b?.eth} />
          </div>
          {gasNote && <PayerGas o={o} empty={b?.eth === 0n} eth={b?.eth} />}
          {!o.ready && o.kind === 'linked' && (
            <button type="button" className="btn btn--dark btn--sm payer__connect" disabled={sw.busy === o.address} onClick={() => void sw.use(o)}>{sw.busy === o.address ? 'connecting…' : `connect ${shortA(o.address)}`}</button>
          )}
        </motion.div>
      </AnimatePresence>
      {ps.options.length > 1 && (
        <div className="wm-list">
          <div className="eyebrow">your wallets</div>
          <ul className="wm-rows" role="radiogroup" aria-label="paying wallet">
            {ps.options.map(x => {
              const xb = bal.data?.[x.address]
              const active = x.address === o.address
              const needsConnect = !x.ready && x.kind === 'linked'
              const busy = sw.busy === x.address
              return (
                <li key={x.address}>
                  <button type="button" role="radio" aria-checked={active} className={`wm-row ${active ? 'is-active' : ''}`} disabled={busy} data-testid="wm-row"
                    onClick={() => { if (!active) void sw.use(x) }}>
                    <WalletAvatar address={x.address} size={28} />
                    <span className="wm-row__main">
                      <span className="wm-row__top"><code className="mono">{addrLabel(x.address)}</code><KindPill kind={x.kind} /></span>
                      <span className="wm-row__bal tiny num">{fmtUnits(xb?.wif, 'wif')} · {fmtUnits(xb?.eth, 'eth')}</span>
                    </span>
                    <span className="wm-row__end">
                      {active ? <span className="wm-check" aria-hidden="true"><Icon name="check" size={14} /></span>
                        : busy ? <span className="tiny muted">connecting…</span>
                          : needsConnect ? <span className="wm-connect">connect</span> : <span className="wm-ring" aria-hidden="true" />}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {sw.err && <p className="tiny payer__err">{sw.err}</p>}
    </div>
  )
}
