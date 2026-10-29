/** Sell a .wif: the list-for-sale sheet (price, live usd, 2.5% fee, you receive, onchain list), change price, cancel; and the buyer's listing card. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence } from 'motion/react'
import { api } from '../api/client'
import { useSession } from '../api/session'
import { useAnyAccount } from '../auth/privyBridge'
import { FEE_SPLIT, NAMES_ADDRESS, NAME_FEE_BPS } from '../config'
import { useWifBalance } from '../lib/chain'
import { usdText, useWifPrice } from '../lib/price'
import { plans } from '../lib/wifly'
import { PREVIEW_NOTE, useStore } from '../state/store'
import { Sheet } from '../sheets/Sheets'
import { InfoTip } from './InfoTip'
import { LowBalance } from './Swap'
import { TxSteps } from './TxSteps'
import { NameCard } from './WifName'
import { useNameTx, type Mine } from '../pages/Names'

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
const LIVE = !!NAMES_ADDRESS

function UsdOf({ wif }: { wif: number }) {
  const { usd, stale } = useWifPrice()
  if (!(wif > 0) || usd === undefined || stale) return null
  return <span className="muted">≈ ${usdText(wif * usd)}</span>
}

export function FeeTip() {
  return <InfoTip label="about the sale fee">{NAME_FEE_BPS / 100}% of the price: {FEE_SPLIT.pot}% to the weekly pot, {FEE_SPLIT.burn}% burned. the rest goes to the seller.</InfoTip>
}

/** List, change price or cancel. Opens from the profile pill and the names page. */
export function ListNameSheet({ name, onClose }: { name: string; onClose: () => void }) {
  const mine = useQuery({ queryKey: ['names', 'mine'], queryFn: () => api<Mine>('/names/mine') })
  const current = mine.data?.names.find(n => n.name === name)?.listing?.price ?? null
  const [raw, setRaw] = useState<string | null>(null)
  const value = raw ?? (current ? String(current) : '')
  const p = Number(value)
  const fee = p * NAME_FEE_BPS / 10_000
  const { run, busy } = useNameTx()
  const same = current !== null && p === current
  const list = async () => {
    if (await run(`list:${name}`, plans.nameList(name, p), () => api(`/names/${name}/list`, { method: 'POST', json: { price: p } }), current ? `${name}.wif now ${fmt(p)} wif` : `${name}.wif listed for ${fmt(p)} wif`)) onClose()
  }
  const cancel = async () => {
    if (await run(`del:${name}`, plans.nameCancel(name), () => api(`/names/${name}/list`, { method: 'DELETE' }), `${name}.wif is off the market`)) onClose()
  }
  return (
    <Sheet title={current ? `${name}.wif is listed` : `list ${name}.wif`} onClose={onClose}
      footer={<div className="listsheet__acts">
        <button className="btn btn--dark btn--block" data-testid="list-submit" disabled={!!busy || !(p > 0) || same} onClick={list}>
          {busy === `list:${name}` ? 'confirm in your wallet…' : current ? 'change price' : 'list for sale'}</button>
        {current !== null && <button className="btn btn--ghost btn--block" disabled={!!busy} onClick={cancel}>{busy === `del:${name}` ? 'confirm in your wallet…' : 'cancel listing'}</button>}
      </div>}>
      <div className="listsheet" data-testid="list-sheet">
        <NameCard size="sm" label={name} state="yours" />
        <label className="field">
          <span className="field__label">price</span>
          <span className="field__input field__input--lg">
            <input inputMode="decimal" autoFocus placeholder="0" value={value} aria-label={`price for ${name}.wif in wif`} onChange={e => setRaw(e.target.value.replace(/[^0-9.]/g, ''))} />
            <span className="field__suffix">wif</span>
          </span>
        </label>
        <dl className="listsheet__sum">
          <div><dt>usd</dt><dd><UsdOf wif={p} />{!(p > 0) && <span className="muted">—</span>}</dd></div>
          <div><dt>fee {NAME_FEE_BPS / 100}%<FeeTip /></dt><dd>{p > 0 ? `${fmt(fee)} wif` : '—'}</dd></div>
          <div className="listsheet__get"><dt>you receive</dt><dd>{p > 0 ? `${fmt(p - fee)} wif` : '—'}</dd></div>
        </dl>
        <p className="tiny muted listsheet__note">one wallet confirmation, no approval needed. if it sells, the name’s records reset.
          <InfoTip label="what happens when it sells">the buyer gets the name and its @. you go back to picking a free @name.</InfoTip></p>
        {!LIVE && <p className="tiny muted">{PREVIEW_NOTE}</p>}
      </div>
    </Sheet>
  )
}

/** A calm card for a listed name: price, usd, buy (onchain buy with a max price). */
export function BuyCard({ name, price, mine, onManage }: { name: string; price: number; mine?: boolean; onManage?: () => void }) {
  const { me } = useSession()
  const { openSheet } = useStore()
  const { address } = useAnyAccount()
  const wif = useWifBalance(address).value
  const { run, busy } = useNameTx()
  const buy = () => {
    if (!me) return openSheet({ type: 'signin' })
    run(`buy:${name}`, plans.nameBuy(name, price), h => api(`/names/${name}/buy`, { method: 'POST', json: { txHash: h } }), `${name}.wif is yours`)
  }
  return (
    <section className="card buycard" data-testid="buy-card">
      <div className="buycard__row">
        <span className="buycard__label">for sale</span>
        <span className="buycard__price"><b>{fmt(price)} wif</b> <UsdOf wif={price} /></span>
      </div>
      {mine ? <button className="btn btn--ghost btn--block" onClick={onManage}>change price or cancel</button> : <>
        {/* 11.8.8: paying-from + steps above the buy button, like every sheet */}
        <TxSteps pull={price} action={`buy ${name}.wif`} />
        {wif !== undefined && wif < price && <LowBalance need={price} what={`buy ${name}.wif`} />}
        <button className="btn btn--dark btn--block" data-testid="buy-name" disabled={!!busy} onClick={buy}>{busy === `buy:${name}` ? 'confirm in your wallet…' : `buy ${name}.wif`}</button>
        <p className="tiny muted buycard__note">includes the {NAME_FEE_BPS / 100}% fee<FeeTip /></p>
      </>}
    </section>
  )
}

/** The pill's "list for sale" entry point as a self-contained button + sheet. */
export function ListNameButton({ name, label = 'list for sale', className = 'btn btn--ghost btn--block' }: { name: string; label?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className={className} data-testid="list-open" onClick={() => setOpen(true)}>{label}</button>
    <AnimatePresence>{open && <ListNameSheet name={name} onClose={() => setOpen(false)} />}</AnimatePresence>
  </>
}
