/**
 * Settings > wallets: every wallet on the account (main, linked, the privy embedded one), each with its address,
 * WIF and ETH balance read from Robinhood Chain, and copy. Switching main / receiving needs a signature from that wallet.
 * The embedded wallet can withdraw (signed by Privy's embedded signer, after a confirm step) and export its key in Privy's
 * own modal: the key never shows in this app.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AnimatePresence } from 'motion/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { encodeFunctionData, erc20Abi, formatUnits, isAddress, parseUnits, type Address } from 'viem'
import { api } from '../api/client'
import { useSession, type Me, type MeWallet } from '../api/session'
import { privyBridge, privyUsable, wantPrivy } from '../auth/privyBridge'
import { EXPLORER, explorerAddress, robinhoodChain, TX_ENABLED, WIF_DECIMALS, WIF_TOKEN } from '../config'
import { useStore } from '../state/store'
import { Sheet } from '../sheets/Sheets'
import { useLinker } from './LinkAccounts'
import { useWalletProof, shortAddr } from './WalletProofs'
import { Icon } from './Icon'
import { InfoTip } from './InfoTip'
import { Avatar } from './Bits'
import { Qr } from './Qr'
import { gateCopy, walletAccess, type Access } from '../lib/walletAccess'

type Bal = { wif: bigint; eth: bigint }
const fmt = (v: bigint | undefined, max = 4) => v === undefined ? '…' : Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: max })
const GAS_BUFFER = 3n // keep 3x the estimated fee back when sending max ETH

/** WIF + ETH balances for a set of wallets, read straight from chain 4663. Read-only. */
export function useBalances(addresses: string[]) {
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

export function CopyBtn({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="wl__copy" aria-label={label} onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400) }}>
      <Icon name={done ? 'check' : 'copy'} size={14} /><span>{done ? 'copied' : 'copy'}</span>
    </button>
  )
}

/** Can this browser's privy session sign for an embedded wallet? Only the privy login (x or email) that created it can. */
function useAccess() {
  const ps = useSyncExternalStore(privyBridge.subscribe, privyBridge.get)
  return (w: MeWallet): Access => walletAccess(w, { enabled: privyUsable, ready: ps.ready, authenticated: ps.authenticated, owns: a => privyBridge.has(a) })
}

export function WalletsSection() {
  const { me, setMe, refresh, verifyWallet } = useSession()
  const { toast } = useStore()
  const qc = useQueryClient()
  const prove = useWalletProof()
  const linker = useLinker({ keptErrors: false })
  const access = useAccess()
  const list = useMemo<MeWallet[]>(() => me?.links?.walletList ?? [], [me?.links?.walletList])
  const bal = useBalances(list.map(w => w.address))
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [withdraw, setWithdraw] = useState<string | null>(null)
  const [deposit, setDeposit] = useState<string | null>(null)
  const hasPrivy = list.some(w => w.privy)
  useEffect(() => { if (hasPrivy) wantPrivy() }, [hasPrivy])
  // back from x.com after a one-tap verify: say how it went, calmly
  useEffect(() => {
    const ok = () => toast('verified. this wallet is ready here', undefined, 'ok')
    const closed = () => toast('not verified. nothing changed on your account')
    window.addEventListener('wifly:verified', ok); window.addEventListener('wifly:verify-closed', closed)
    return () => { window.removeEventListener('wifly:verified', ok); window.removeEventListener('wifly:verify-closed', closed) }
  }, [toast])
  if (!me) return null

  const act = async (key: string, fn: () => Promise<void>) => {
    if (busy) return
    setBusy(key); setErr(null)
    try { await fn() } catch (e) {
      const m = (e as Error).message || 'that didn’t go through'
      if (!/reject|denied|closed|exited/i.test(m)) setErr(m.toLowerCase())
    } finally { setBusy(null) }
  }
  const makeMain = (a: string) => act(`main:${a}`, async () => {
    const p = await prove('main', a)
    const r = await api<{ me?: Me }>('/settings/main', { method: 'POST', json: p })
    if (r.me) setMe(r.me)
    refresh(); void qc.invalidateQueries({ queryKey: ['settings', 'tips'] })
    toast(`main wallet is now ${shortAddr(a)}`, undefined, 'ok')
  })
  const receive = (a: string) => act(`tips:${a}`, async () => {
    const p = await prove('tips', a)
    await api('/settings/tips', { method: 'POST', json: p })
    refresh(); void qc.invalidateQueries({ queryKey: ['settings', 'tips'] })
    toast(`tips now go to ${shortAddr(a)}`, undefined, 'ok')
  })
  const exportKey = (a: string) => act(`export:${a}`, async () => { await privyBridge.exportWallet(a) })
  // not this session's wallet: one tap swaps privy (only privy; this account stays signed in) to the x or email login
  // that owns it and attaches it to this same account. cancelled: privy is simply logged out here, nothing else changed.
  const useIt = (w: MeWallet) => act(`use:${w.address}`, async () => {
    const kind = w.owner?.via === 'email' ? 'email' : 'x'
    try { location.hash = 'wallets' } catch { /* ignore */ }
    const r = await verifyWallet(kind)
    if (r === 'ok') toast('verified. this wallet is ready here', undefined, 'ok')
    else toast('not verified. nothing changed on your account')
  })

  const main = list.find(w => w.main) ?? list[0]
  const rest = list.filter(w => w !== main)
  const who = me.wifName ? `${me.wifName}.wif` : me.handle ? `@${me.handle}` : 'your wallet'

  const tags = (w: MeWallet) => <span className="wl__tags">
    {w.main && <span className="wl__tag">main</span>}
    {w.receiving && <span className="wl__tag wl__tag--soft">receiving</span>}
    {w.privy && <span className="wl__tag wl__tag--soft">embedded</span>}
  </span>
  const actions = (w: MeWallet) => {
    const a = access(w)
    if (a !== 'yes') {
      const g = gateCopy(a, w.owner)
      return (
        <div className="wl__gate" data-testid="wallet-gate" data-access={a}>
          <p className="small muted">{g.line}</p>
          {g.button && <span className="wl__verify"><button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} data-testid="wallet-use" onClick={() => useIt(w)}>{busy === `use:${w.address}` ? 'verifying…' : g.button}</button>{g.sub && <span className="wl__verify-sub">{g.sub}</span>}</span>}
          <button type="button" className="wl__btn" onClick={() => setDeposit(w.address)} data-testid="wallet-deposit"><Icon name="down" size={15} />deposit</button>
        </div>
      )
    }
    return (
      <div className="wl__acts">
        <button type="button" className="wl__btn" onClick={() => setDeposit(w.address)} data-testid="wallet-deposit"><Icon name="down" size={15} />deposit</button>
        {w.privy && <button type="button" className="wl__btn" disabled={!!busy} onClick={() => setWithdraw(w.address)} data-testid="wallet-withdraw"><Icon name="up" size={15} />withdraw</button>}
        {w.privy && <button type="button" className="wl__btn" disabled={!!busy} onClick={() => exportKey(w.address)} data-testid="wallet-export"><Icon name="lock" size={15} />{busy === `export:${w.address}` ? 'opening…' : 'export key'}</button>}
        {!w.main && <button type="button" className="wl__btn wl__btn--quiet" disabled={!!busy} onClick={() => makeMain(w.address)}>{busy === `main:${w.address}` ? 'sign…' : 'make main'}</button>}
        {!w.receiving && <button type="button" className="wl__btn wl__btn--quiet" disabled={!!busy} onClick={() => receive(w.address)}>{busy === `tips:${w.address}` ? 'sign…' : 'get tips here'}</button>}
      </div>
    )
  }

  return (
    <div className="wl" data-testid="wallets">
      {!main ? <p className="muted small">no wallet yet. link one to hold WIF and get tips.</p> : (() => {
        const b = bal.data?.[main.address]
        return (
          <section className="wlm" data-testid="wallet-main">
            <div className="wlm__top">
              {me.handle && <Avatar handle={me.handle} size={40} />}
              <span className="wlm__who"><b className="clamp-1">{who}</b><span className="wlm__addr"><span className="mono" title={main.address}>{shortAddr(main.address)}</span><CopyBtn text={main.address} label={`copy ${shortAddr(main.address)}`} /><a className="wl__ext" href={explorerAddress(main.address)} target="_blank" rel="noreferrer" aria-label="open in explorer"><Icon name="external" size={13} /></a></span>{tags(main)}</span>
            </div>
            <div className="wlm__bals" data-testid="wallet-balance">
              <div className="wlm__bal"><span className="wlm__label">WIF</span><b className="num">{fmt(b?.wif, 2)}</b></div>
              <div className="wlm__bal"><span className="wlm__label">ETH</span><b className="num">{fmt(b?.eth, 6)}</b></div>
            </div>
            {actions(main)}
          </section>
        )
      })()}
      {rest.length > 0 && <>
        <h3 className="wl__sub">other wallets</h3>
        <ul className="wl__list">
          {rest.map(w => {
            const b = bal.data?.[w.address]
            return (
              <li key={w.address} className="wl__row" data-testid="wallet-row">
                <div className="wl__top">
                  <span className="wl__addr mono" title={w.address}>{shortAddr(w.address)}</span>
                  <CopyBtn text={w.address} label={`copy ${shortAddr(w.address)}`} />
                  {tags(w)}
                </div>
                <div className="wl__bal" data-testid="wallet-balance">
                  <span><b className="num">{fmt(b?.wif, 2)}</b> WIF</span>
                  <span><b className="num">{fmt(b?.eth, 6)}</b> ETH</span>
                </div>
                {actions(w)}
              </li>
            )
          })}
        </ul>
      </>}
      <div className="wl__foot">
        <button type="button" className="btn btn--ghost btn--sm" disabled={!!linker.busy} onClick={() => linker.run('wallet')}>
          {linker.busy === 'wallet' ? 'check your wallet…' : list.length ? 'add another wallet' : 'link a wallet'}</button>
        <span className="small muted">live onchain balances</span>
      </div>
      {(me.links?.x || me.links?.email) && (
        <div className="wl__signins" data-testid="wallet-signins">
          <h3 className="wl__sub">signs in with</h3>
          {me.links?.x && <div className="wl__signin"><Icon name="x" size={16} /><span>x</span><b>@{me.links.x}</b></div>}
          {me.links?.email && <div className="wl__signin"><Icon name="mail" size={16} /><span>email</span><b>{me.links.email}</b></div>}
        </div>
      )}
      {(err || linker.error) && <p className="small bad" role="alert">{err || linker.error}</p>}
      <AnimatePresence>{withdraw && <WithdrawSheet from={withdraw} bal={bal.data?.[withdraw]} onClose={() => setWithdraw(null)} onSent={() => { void bal.refetch() }} />}</AnimatePresence>
      <AnimatePresence>{deposit && <DepositSheet address={deposit} onClose={() => setDeposit(null)} />}</AnimatePresence>
    </div>
  )
}

/** Receive: the full address, a QR made in the browser, and copy. */
export function DepositSheet({ address, onClose }: { address: string; onClose: () => void }) {
  return (
    <Sheet title="deposit" onClose={onClose} size="sm">
      <div className="dep" data-testid="deposit-sheet">
        <Qr text={address} label={`qr code for ${shortAddr(address)}`} />
        <p className="mono dep__addr">{address}</p>
        <CopyBtn text={address} label="copy address" />
        <p className="small muted">send WIF or ETH on chain {robinhoodChain.id} only. anything sent on another network won’t arrive.</p>
      </div>
    </Sheet>
  )
}

type Asset = 'WIF' | 'ETH'
/** Send WIF or ETH out of the embedded wallet. Form, then a confirm step with amount, est. network fee and destination. */
export function WithdrawSheet({ from, bal, onClose, onSent, initial }: { from: string; bal?: Bal; onClose: () => void; onSent?: () => void; initial?: { asset?: Asset; to?: string; amount?: string; step?: 'form' | 'confirm' } }) {
  const client = usePublicClient({ chainId: robinhoodChain.id })
  const { unlockPrivy } = useSession()
  const { toast } = useStore()
  const [asset, setAsset] = useState<Asset>(initial?.asset ?? 'WIF')
  const [to, setTo] = useState(initial?.to ?? '')
  const [amount, setAmount] = useState(initial?.amount ?? '')
  const [step, setStep] = useState<'form' | 'confirm' | 'sent'>(initial?.step ?? 'form')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const gasPrice = useQuery({ queryKey: ['gasprice'], enabled: !!client, refetchInterval: 20_000, queryFn: () => client!.getGasPrice() })

  const have = asset === 'WIF' ? bal?.wif : bal?.eth
  const toOk = isAddress(to.trim()) && to.trim().toLowerCase() !== from.toLowerCase() && !/^0x0{40}$/i.test(to.trim())
  let value: bigint | null = null
  try { value = amount.trim() && Number(amount) > 0 ? parseUnits(amount.trim() as `${number}`, asset === 'WIF' ? WIF_DECIMALS : 18) : null } catch { value = null }
  const tx = useMemo(() => {
    if (!toOk || !value) return null
    const dest = to.trim() as Address
    return asset === 'ETH' ? { to: dest, data: '0x' as `0x${string}`, value }
      : { to: WIF_TOKEN, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [dest, value] }), value: 0n }
  }, [asset, to, toOk, value])
  const est = useQuery({
    queryKey: ['estgas', from, tx?.to, tx?.data, String(tx?.value ?? '')], enabled: !!client && !!tx && step !== 'form',
    queryFn: async () => {
      const gas = await client!.estimateGas({ account: from as Address, to: tx!.to, data: tx!.data, value: tx!.value })
      const price = gasPrice.data ?? await client!.getGasPrice()
      return { gas, fee: gas * price }
    },
    retry: false,
  })
  // a rough fee before the exact estimate: a plain transfer (21k) or a token transfer (~65k)
  const roughFee = gasPrice.data !== undefined ? gasPrice.data * (asset === 'ETH' ? 21_000n : 65_000n) : undefined
  const fee = est.data?.fee ?? roughFee
  // max ETH keeps the fee back: a real estimate for this send (L2 + L1 parts), times GAS_BUFFER; never all of it
  const [maxBusy, setMaxBusy] = useState(false)
  const max = async () => {
    if (have === undefined) return
    if (asset === 'WIF') return setAmount(formatUnits(have, WIF_DECIMALS))
    setMaxBusy(true)
    try {
      const price = gasPrice.data ?? (client ? await client.getGasPrice() : undefined)
      if (price === undefined) throw new Error('no gas price')
      const dest = (toOk ? to.trim() : from) as Address
      const gas = client ? await client.estimateGas({ account: from as Address, to: dest, value: 1n }).catch(() => 21_000n) : 21_000n
      const keep = (gas > 21_000n ? gas : 21_000n) * price * GAS_BUFFER
      setAmount(formatUnits(have > keep ? have - keep : 0n, 18))
      setErr(null)
    } catch { setErr('couldn’t read the network fee. try max again in a moment') }
    finally { setMaxBusy(false) }
  }
  const tooMuch = value !== null && have !== undefined && value > have
  const ethLeft = bal ? bal.eth - (asset === 'ETH' ? value ?? 0n : 0n) : undefined
  const noGas = fee !== undefined && ethLeft !== undefined && ethLeft < fee
  const formErr = to.trim() && !toOk ? (to.trim().toLowerCase() === from.toLowerCase() ? 'that’s this same wallet' : 'that isn’t a wallet address')
    : tooMuch ? `more than this wallet holds` : value !== null && noGas ? 'not enough ETH left for the network fee' : null
  const canReview = toOk && !!value && !tooMuch && !noGas

  const send = async () => {
    if (!tx || busy) return
    setBusy(true); setErr(null)
    try {
      if (!TX_ENABLED) throw new Error('sending opens when payments go live')
      if (!privyBridge.has(from)) {
        if (!(await unlockPrivy())) return
        if (!privyBridge.has(from)) throw new Error('this wallet belongs to another x or email sign-in. sign in with that one to use it')
      }
      const h = await privyBridge.sendFrom(from, tx.to, tx.data, robinhoodChain.id, tx.value || undefined)
      setHash(h); setStep('sent'); onSent?.()
      toast('sent', undefined, 'ok')
    } catch (e) {
      const m = (e as Error).message || 'that didn’t go through'
      if (!/reject|denied|closed|exited/i.test(m)) setErr(m.toLowerCase())
    } finally { setBusy(false) }
  }

  return (
    <Sheet title={step === 'confirm' ? 'confirm withdraw' : step === 'sent' ? 'sent' : 'withdraw'} onClose={onClose} size="sm">
      <div className="wd" data-testid={`withdraw-${step}`}>
        {step === 'form' && <>
          <p className="small muted wd__from">from embedded <span className="mono">{shortAddr(from)}</span></p>
          <div className="seg wd__seg" role="tablist" aria-label="what to send">
            {(['WIF', 'ETH'] as Asset[]).map(a => <button key={a} type="button" role="tab" aria-selected={asset === a} className={asset === a ? 'is-on' : ''} onClick={() => { setAsset(a); setAmount('') }}>{a}</button>)}
          </div>
          <label className="field">
            <span className="field__label">to</span>
            <input className="field__input mono wd__to" value={to} onChange={e => setTo(e.target.value)} placeholder="0x… wallet address" spellCheck={false} autoComplete="off" inputMode="text" data-testid="withdraw-to" />
          </label>
          <label className="field">
            <span className="field__label wd__amtlabel"><span>amount</span><span className="tiny muted">you have {fmt(have, asset === 'WIF' ? 2 : 6)} {asset}</span></span>
            <span className="wd__amt">
              <input className="field__input" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" inputMode="decimal" data-testid="withdraw-amount" />
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => { void max() }} disabled={have === undefined || maxBusy} data-testid="withdraw-max">{maxBusy ? '…' : 'max'}</button>
            </span>
          </label>
          {asset === 'ETH' && <p className="tiny muted">max keeps a little ETH back for the network fee.</p>}
          {(formErr || err) && <p className="tiny bad" role="alert">{formErr ?? err}</p>}
          <button type="button" className="btn btn--dark wd__go" disabled={!canReview} onClick={() => setStep('confirm')}>review</button>
        </>}
        {step === 'confirm' && tx && value !== null && <>
          <dl className="wd__sum">
            <div><dt>send</dt><dd><b>{Number(formatUnits(value, asset === 'WIF' ? WIF_DECIMALS : 18)).toLocaleString('en-US', { maximumFractionDigits: 6 })} {asset}</b></dd></div>
            <div><dt>to</dt><dd className="mono wd__full">{to.trim().toLowerCase()}</dd></div>
            <div><dt>from</dt><dd className="mono">{shortAddr(from)} <span className="muted">embedded</span></dd></div>
            <div><dt>est. network fee</dt><dd data-testid="withdraw-fee">{fee !== undefined ? `~${Number(formatUnits(fee, 18)).toLocaleString('en-US', { maximumSignificantDigits: 3 })} ETH` : est.isError ? 'couldn’t estimate' : '…'}{est.isFetching && est.data === undefined && fee !== undefined ? <span className="muted"> (checking…)</span> : null}</dd></div>
            {fee !== undefined && <div className="wd__total" data-testid="withdraw-total"><dt>total</dt><dd>{asset === 'ETH'
              ? <b>~{Number(formatUnits(value + fee, 18)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ETH</b>
              : <><b>{Number(formatUnits(value, WIF_DECIMALS)).toLocaleString('en-US', { maximumFractionDigits: 6 })} WIF</b> <span className="muted">+ ~{Number(formatUnits(fee, 18)).toLocaleString('en-US', { maximumSignificantDigits: 3 })} ETH fee</span></>}</dd></div>}
          </dl>
          {noGas && <p className="tiny bad" role="alert">not enough ETH left for the network fee</p>}
          <p className="tiny muted"><Icon name="shield" size={12} /> sends can’t be undone. check the address.</p>
          {!TX_ENABLED && <p className="tiny muted">sending opens when payments go live.</p>}
          {err && <p className="tiny bad" role="alert">{err}</p>}
          <div className="wd__btns">
            <button type="button" className="btn btn--ghost" onClick={() => setStep('form')} disabled={busy}>back</button>
            <button type="button" className="btn btn--dark" onClick={send} disabled={busy || !TX_ENABLED || noGas || tooMuch || fee === undefined} data-testid="withdraw-send">{busy ? 'confirm in privy…' : 'send'}</button>
          </div>
        </>}
        {step === 'sent' && <>
          <p className="small">on its way. it lands in a few seconds.</p>
          {hash && <a className="linkbtn" href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">view on explorer</a>}
          <button type="button" className="btn btn--dark wd__go" onClick={onClose}>done</button>
        </>}
      </div>
    </Sheet>
  )
}

/** Small explainer for the section title. */
export function WalletsTip() {
  return <InfoTip label="about wallets">every wallet on this account. main is the one shown on your profile; tips land on the receiving one. changing either needs a signature from that wallet.</InfoTip>
}
