/**
 * Settings > wallets: every wallet on the account (main, linked, the privy embedded one), each with its address,
 * WIF and ETH balance read from Robinhood Chain, and copy. Switching main / receiving needs a signature from that wallet.
 * The embedded wallet can withdraw (signed by Privy's embedded signer, after a confirm step) and export its key in Privy's
 * own modal: the key never shows in this app.
 */
import { useMemo, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { encodeFunctionData, erc20Abi, formatUnits, isAddress, parseUnits, type Address } from 'viem'
import { api } from '../api/client'
import { useSession, type Me, type MeWallet } from '../api/session'
import { privyBridge, privyEnabled } from '../auth/privyBridge'
import { EXPLORER, explorerAddress, robinhoodChain, TX_ENABLED, WIF_DECIMALS, WIF_TOKEN } from '../config'
import { useStore } from '../state/store'
import { Sheet } from '../sheets/Sheets'
import { useLinker } from './LinkAccounts'
import { useWalletProof, shortAddr } from './WalletProofs'
import { Icon } from './Icon'
import { InfoTip } from './InfoTip'

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

export function WalletsSection() {
  const { me, setMe, refresh, unlockPrivy } = useSession()
  const { toast } = useStore()
  const qc = useQueryClient()
  const prove = useWalletProof()
  const linker = useLinker({ keptErrors: false })
  const list = useMemo<MeWallet[]>(() => me?.links?.walletList ?? [], [me?.links?.walletList])
  const bal = useBalances(list.map(w => w.address))
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [withdraw, setWithdraw] = useState<string | null>(null)
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
  const exportKey = (a: string) => act(`export:${a}`, async () => {
    if (!privyEnabled) throw new Error('x and email sign-in is off here, so this wallet can’t open')
    if (!privyBridge.has(a)) {
      if (!(await unlockPrivy())) return
      if (!privyBridge.has(a)) throw new Error('this wallet belongs to another x or email sign-in. sign in with that one to use it')
    }
    await privyBridge.exportWallet(a)
  })

  return (
    <div className="wl" data-testid="wallets">
      {!list.length ? <p className="muted small">no wallet yet. link one to hold WIF and get tips.</p> : (
        <ul className="wl__list">
          {list.map(w => {
            const b = bal.data?.[w.address]
            return (
              <li key={w.address} className="wl__row" data-testid="wallet-row">
                <div className="wl__top">
                  <span className="wl__addr mono" title={w.address}>{shortAddr(w.address)}</span>
                  <CopyBtn text={w.address} label={`copy ${shortAddr(w.address)}`} />
                  <span className="wl__tags">
                    {w.main && <span className="wl__tag">main</span>}
                    {w.receiving && <span className="wl__tag wl__tag--soft">receiving</span>}
                    {w.privy && <span className="wl__tag wl__tag--soft">embedded</span>}
                  </span>
                </div>
                <div className="wl__bal small" data-testid="wallet-balance">
                  <span><b>{fmt(b?.wif, 2)}</b> WIF</span>
                  <span className="muted">·</span>
                  <span><b>{fmt(b?.eth, 6)}</b> ETH</span>
                  <a className="wl__ext tiny muted" href={explorerAddress(w.address)} target="_blank" rel="noreferrer" aria-label="open in explorer"><Icon name="external" size={12} /></a>
                </div>
                <div className="wl__acts">
                  {!w.main && <button type="button" className="linkbtn" disabled={!!busy} onClick={() => makeMain(w.address)}>{busy === `main:${w.address}` ? 'sign…' : 'make main'}</button>}
                  {!w.receiving && <button type="button" className="linkbtn" disabled={!!busy} onClick={() => receive(w.address)}>{busy === `tips:${w.address}` ? 'sign…' : 'get tips here'}</button>}
                  {w.privy && <button type="button" className="linkbtn" disabled={!!busy} onClick={() => setWithdraw(w.address)}>withdraw</button>}
                  {w.privy && <button type="button" className="linkbtn" disabled={!!busy} onClick={() => exportKey(w.address)}>{busy === `export:${w.address}` ? 'opening…' : 'export key'}</button>}
                </div>
              </li>
            )
          })}
        </ul>)}
      <div className="wl__foot">
        <button type="button" className="btn btn--ghost btn--sm" disabled={!!linker.busy} onClick={() => linker.run('wallet')}>
          {linker.busy === 'wallet' ? 'check your wallet…' : list.length ? 'add another wallet' : 'link a wallet'}</button>
        <span className="tiny muted">live onchain balances</span>
      </div>
      {(err || linker.error) && <p className="tiny bad" role="alert">{err || linker.error}</p>}
      <AnimatePresence>{withdraw && <WithdrawSheet from={withdraw} bal={bal.data?.[withdraw]} onClose={() => setWithdraw(null)} onSent={() => { void bal.refetch() }} />}</AnimatePresence>
    </div>
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
            {asset === 'ETH' && fee !== undefined && <div><dt>total</dt><dd>~{Number(formatUnits(value + fee, 18)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ETH</dd></div>}
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
