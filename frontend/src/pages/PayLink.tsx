import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import type { Address } from 'viem'
import { isWifName, useResolve } from '../lib/names'
import { ResolveLine } from '../sheets/Sheets'
import { APP_NAME } from '../brand'
import { LIVE } from '../config'
import { PREVIEW_NOTE, useStore } from '../state/store'
import { failArgs, plans, useSendPlan } from '../lib/wifly'
import { Corners, Wordmark } from '../components/Bits'
import { FeeSplit } from '../components/FeeSplit'
import { TxSteps } from '../components/TxSteps'
import { LowBalance } from '../components/Swap'
import { WalletChip } from '../components/WalletChip'

/** A shareable link anyone can pay, with or without an account. Uses Wifly.pay(seller, amount, orderId). */
export function PayLink() {
  const { id = '' } = useParams()
  if (isWifName(id) || /^0x[0-9a-fA-F]{40}$/.test(id)) return <PayName to={id} />
  return <PayLinkFixed id={id} />
}

/** /pay/alice.wif?amount=50 — pay any name.wif (resolved onchain to the holder's wallet) or address. */
function PayName({ to }: { to: string }) {
  const [sp] = useSearchParams()
  const [amount, setAmount] = useState(Math.max(1, Math.min(1_000_000, Number(sp.get('amount')) || 100)))
  const res = useResolve(to)
  const r = res.data ?? null
  const { toast } = useStore()
  const send = useSendPlan()
  const [busy, setBusy] = useState(false)
  const pay = async () => {
    if (!r?.address) return
    if (!LIVE) { toast('not sent', PREVIEW_NOTE); return }
    if (busy) return
    setBusy(true)
    try {
      const x = await send(plans.pay(r.address as Address, amount, 'paylink', `name:${r.label}`))
      if (x.sent) toast('paid', 'confirmed onchain'); else toast(...failArgs(x))
    } finally { setBusy(false) }
  }
  return (
    <div className="paylink">
      <header className="paylink__top"><Wordmark /><WalletChip compact /></header>
      <main className="paylink__card">
        <Corners />
        <h1 className="paylink__title">pay {r?.label ?? to}</h1>
        <ResolveLine raw={to} loading={res.isFetching} r={r} />
        <label className="field"><span className="field__label">amount</span><span className="field__input"><input inputMode="decimal" value={amount} onChange={e => setAmount(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} /><span className="muted">wif</span></span></label>
        <FeeSplit amount={amount} recipientLabel={`${r?.label ?? 'they'} receive`} />
        <LowBalance need={amount} />
        <TxSteps pull={amount} action="pay" />
        <button className="btn btn--dark btn--block btn--lg" disabled={!r?.address || !amount || busy} onClick={pay}>{busy ? 'sending…' : `pay ${amount.toLocaleString()} wif`}</button>
      </main>
      <footer className="paylink__foot muted small">made with <Link to="/">{APP_NAME.toLowerCase()}</Link>. get paid in $wif at your .wif name.</footer>
    </div>
  )
}

/** Fixed-price pay links aren't stored on the server yet, so an unknown id gets a clean "not found". */
function PayLinkFixed(_: { id: string }) {
  return (
    <div className="paylink paylink--missing">
      <Wordmark />
      <p>this pay link doesn’t exist or was turned off.</p>
      <p className="muted small">to pay someone, use their name: <span className="mono">/pay/name.wif</span></p>
      <Link to="/" className="btn btn--dark">go to {APP_NAME.toLowerCase()}</Link>
    </div>
  )
}
