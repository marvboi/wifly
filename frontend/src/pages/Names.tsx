import { NameSkel } from '../components/Delight'
import { useAnyAccount } from '../auth/privyBridge'
/**
 * The .wif hub (WIF Names, WIFNAME): search + claim, your names (set primary, manage records), and the $WIF market.
 * name -> wallet is resolve("name.wif") onchain; wallet -> name is reverseName(address). @usernames are separate.
 */
import { at } from '../lib/format'
import { FeeParts } from '../components/FeeSplit'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, type ApiUser } from '../api/client'
import { useSession } from '../api/session'
import { CLAIM_SPLIT, FEE_SPLIT, NAMES_ADDRESS, NAME_FEE_BPS, claimFeeOf } from '../config'
import { splitFee } from '../lib/fees'
import { failTitle, plans, useSendPlan, type Plan } from '../lib/wifly'
import { namePlans, normalizeName, useNameCheck } from '../lib/names'
import { companion } from '../lib/companion'
import { useWifBalance } from '../lib/chain'
import { PREVIEW_NOTE, useStore } from '../state/store'
import { PageHead } from '../components/Shell'
import { Amount, Avatar, PriceTag } from '../components/Bits'
import { usdText, useWifPrice } from '../lib/price'
import { Icon, type IconName } from '../components/Icon'
import { LowBalance, shortfallWif } from '../components/Swap'
import { TxSteps } from '../components/TxSteps'
import { Mascot, type Mood } from '../components/Mascot'
import { NameCard, ThemePicker, WifName, defaultThemeOf, nameArtUrl } from '../components/WifName'
import { Empty } from '../companion/Companion'


type Listing = {
  name: string; price: number; seller?: ApiUser; mine: boolean; forYou: boolean; listedAt: number
  fee: { total: number; treasury: number; pot: number; burn: number; sellerGets: number }; offers: number; topOffer: number | null
}
type Market = { listings: Listing[]; recentSales: { name: string; price: number; created_at: number }[]; live: boolean; feeBps: number }
export type Mine = {
  primary?: string; names: { name: string; display: string; primary: boolean; minted: boolean; listing: { price: number; private: boolean } | null }[]
  offersIn: { id: number; name: string; buyer: string; price: number; expiresAt: number }[]
  offersOut: { id: number; name: string; price: number; expiresAt: number }[]
}
const LIVE = !!NAMES_ADDRESS
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
export const RESET_WARNING = 'records reset on every sale or transfer: the address, avatar, X, link and bio are cleared.'

export function Names() {
  const [sp, setSp] = useSearchParams()
  const t = sp.get('tab')
  const tab = t === 'mine' ? 'mine' : t === 'market' ? 'market' : 'claim'
  const { me } = useSession()
  return (
    <div className="names-page">
      <PageHead title=".wif" back sub="your onchain name." />
      <div className="seg" role="tablist">
        {(['claim', 'mine', 'market'] as const).map(x => <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? 'is-on' : ''} onClick={() => setSp(x === 'claim' ? {} : { tab: x })}>{x === 'mine' ? 'your names' : x === 'claim' ? 'search & claim' : 'market'}</button>)}
      </div>
      {tab === 'claim' && <ClaimTab />}
      {tab === 'mine' && (me ? <MineTab /> : <SignInNote />)}
      {tab === 'market' && <MarketTab />}
      <WifHow />
    </div>
  )
}

/** "how .wif works": five short facts, two columns on desktop, stacked on mobile. Numbers come from config. */
export function WifHow() {
  const items: { icon: IconName; label: string; body: string }[] = [
    { icon: 'wallet', label: 'your name, your wallet', body: 'pick 3–20 characters (a–z, 0–9 and _). it ends in .wif, lives in your wallet as a transferable NFT, and points to whichever wallet holds it.' },
    { icon: 'tip', label: 'price', body: `${fmt(claimFeeOf('abcde'))} WIF to claim, or ${fmt(claimFeeOf('abc'))} WIF for short 3–4 character names. the claim fee goes ${CLAIM_SPLIT.treasury}% to the treasury and ${CLAIM_SPLIT.pot}% to the weekly community pot.` },
    { icon: 'at', label: 'separate from your @username', body: 'your @name is free and always yours. a .wif is an optional upgrade you can trade.' },
    { icon: 'swap', label: 'selling', body: `sales carry a ${NAME_FEE_BPS / 100}% fee: ${FEE_SPLIT.pot}% goes to the weekly community pot and ${FEE_SPLIT.burn}% is burned.` },
    { icon: 'sparkle', label: 'fresh start on transfer', body: 'when a name is sold or sent, its address, avatar, X, link and bio are cleared for the new owner.' },
  ]
  return (
    <section className="wifhow" aria-labelledby="wifhow-title">
      <h3 id="wifhow-title" className="wifhow__title">how .wif works</h3>
      <ul className="wifhow__grid">
        {items.map(it => (
          <li key={it.label} className="wifhow__item">
            <span className="wifhow__icon" aria-hidden="true"><Icon name={it.icon} size={18} /></span>
            <div><b className="wifhow__label">{it.label}</b><p className="wifhow__body">{it.body}</p></div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function SignInNote() {
  const { openSheet } = useStore()
  return <Empty title="sign in to see your names" body="your .wif names live in your wallet." action={<button className="btn btn--dark btn--sm" onClick={() => openSheet({ type: 'signin' })}>sign in</button>} />
}

export function useNameTx() {
  const send = useSendPlan()
  const { toast } = useStore()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  /** Live: chain tx first (receipt awaited), then mirror to the api with the hash. Preview: api only, labelled as preview. */
  const run = async (key: string, plan: Plan | null, mirror: (hash?: string) => Promise<unknown>, done: string): Promise<boolean> => {
    if (busy) return false
    setBusy(key)
    try {
      let hash: string | undefined
      if (LIVE && plan) {
        const r = await send(plan)
        if (!r.sent) { toast(failTitle(r), r.reason); return false }
        hash = r.hash
      }
      await mirror(hash)
      await qc.invalidateQueries({ queryKey: ['names'] })
      await qc.invalidateQueries({ queryKey: ['me'] })
      toast(done, LIVE ? 'confirmed onchain' : PREVIEW_NOTE)
      return true
    } catch (e) { toast('that didn’t go through', (e as Error).message); return false } finally { setBusy(null) }
  }
  return { run, busy }
}

/** Search + claim. Shared with onboarding (Welcome's .wif step uses ClaimBox too). */
export type ClaimState = 'idle' | 'available' | 'taken' | 'reserved' | 'yours' | 'soon'
export const NAMES_LIVE = LIVE

/** Before the names contract is deployed: no claims, no prices, no ownership. Just the honest state. */
export function ClaimSoon({ handle }: { handle?: string }) {
  return (
    <div className="names-soon">
      <span className="names-soon__icon"><Icon name="at" size={20} /></span>
      <div>
        <p className="strong">claiming .wif names opens soon</p>
        <p className="muted small">{handle ? <>@{handle}</> : <>your @name</>} stays free and yours. .wif is the onchain version.</p>
      </div>
    </div>
  )
}

export function ClaimBox({ initial = '', onClaimed, onState, compact, andPrimary }: { initial?: string; onClaimed?: (label: string) => void; onState?: (s: ClaimState, label: string) => void; compact?: boolean; andPrimary?: boolean; cta?: string }) {
  const [raw, setRaw] = useState(initial)
  const { name, check, loading, claimFee } = useNameCheck(raw)
  const { run, busy } = useNameTx()
  const { address } = useAnyAccount()
  const wif = useWifBalance(address).value
  const [claimed, setClaimed] = useState<string | null>(null)
  const [pick, setPick] = useState<1 | 2 | null>(null)
  const look = pick ?? defaultThemeOf(name)
  const ok = LIVE && !!check?.available
  const state: ClaimState = !LIVE ? 'soon' : claimed === name && name ? 'yours' : !name ? 'idle' : !check ? 'idle' : check.available ? 'available' : check.reason === 'reserved' ? 'reserved' : check.reason === 'yours' ? 'yours' : check.reason === 'invalid' ? 'idle' : 'taken'
  const { openSheet } = useStore()
  const valid = /^[a-z0-9_]{3,20}$/.test(name)
  const mood: Mood = state === 'yours' || state === 'available' ? 'happy' : state === 'taken' || state === 'reserved' ? 'oops' : !name ? 'calm' : valid ? (LIVE ? 'think' : 'happy') : name.length < 3 ? 'think' : 'oops'
  const [hop, setHop] = useState(0)
  useEffect(() => { if (mood === 'happy') setHop(h => h + 1) }, [mood])
  useEffect(() => { onState?.(state, name) }, [state, name]) // eslint-disable-line react-hooks/exhaustive-deps
  const claim = async () => {
    const label = normalizeName(raw)
    const t = look === defaultThemeOf(label) ? undefined : look // default look = theme 0, no extra call
    companion.say(`claiming ${label}.wif…`, 'think', 20_000)
    const done = await run(`claim:${label}`, namePlans.claimWithRecords(label, claimFee, {}, address, t, andPrimary), h => api('/names/claim', { method: 'POST', json: { name: label, txHash: h, theme: t ?? 0, ...(andPrimary ? { primary: true } : {}) } }), andPrimary ? `${label}.wif is yours. it’s your @ now` : `${label}.wif is yours`)
    if (done) { setClaimed(label); companion.celebrate('name', `${label}.wif is yours`); onClaimed?.(label) } else companion.say('that didn’t go through', 'oops')
  }
  const short = name.length > 0 && name.length <= 4
  return (
    <section className={`names-claim ${compact ? '' : 'card'}`}>
      <label className="field names-claim__field">
        <span className="field__input field__input--lg">
          {!compact && <span className="names-claim__face" aria-hidden="true"><Mascot size={40} tile={false} mood={mood} pulse={hop} title="" /></span>}
          <input value={raw} onChange={e => { setRaw(e.target.value.replace(/\s/g, '')); setClaimed(null) }} placeholder="yourname" aria-label="name to claim" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={24} />
          <span className="field__suffix">.wif</span>
        </span>
      </label>
      {!LIVE ? <><ClaimSoon />
      <div className="names-claim__look">
        <NameCard size={compact ? 'sm' : 'md'} label={name} theme={look} state={state === 'soon' ? 'idle' : state} fee={LIVE && name ? claimFee : undefined} />
        <div className="names-claim__theme"><span className="field__label">card style</span><ThemePicker label={name} value={look} onChange={setPick} disabled={state === 'yours'} /></div>
      </div>
      </> : <>
        <div className={`names-claim__status small ${state}`} aria-live="polite">
          {!name ? <span className="muted">3–20 characters: a–z, 0–9 and _</span>
            : loading ? <span className="muted">checking {name}.wif…</span>
            : state === 'yours' ? <span className="ok"><Icon name="check" size={14} /> {name}.wif is in your wallet</span>
            : check?.available ? <span className="ok"><Icon name="check" size={14} /> {name}.wif is available</span>
            : check ? <span className="bad">{check.reason === 'reserved' ? `${name}.wif is reserved. try another name.` : check.reason === 'invalid' ? check.message : check.reason === 'listed' ? `taken, but it’s for sale for ${fmt(check.price ?? 0)} WIF` : `${name}.wif is taken. try another name:`}</span> : null}
        </div>
        {!!check?.suggestions.length && !check.available && state !== 'yours' && <div className="names-sugg">{check.suggestions.slice(0, 4).map(s => <button key={s} className="chip chip--sm" onClick={() => setRaw(s)}>{s}.wif</button>)}</div>}
        {check?.reason === 'listed' && <Link className="btn btn--ghost btn--sm" to={`/n/${name}`}>see the listing</Link>}
        {state === 'yours' && <NameCard size={compact ? 'sm' : 'md'} label={name} theme={look} state="yours" owner={address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null} />}
        {state !== 'yours' && <>
          <div className="names-claim__offer">
            <p className="names-claim__headline">{ok ? <>claim {name}.wif for {fmt(claimFee)} WIF<WifUsdNote wif={claimFee} /></> : <>claim fee</>}</p>
            <PriceTag value={name ? claimFee : claimFeeOf('abcde')} size={16} align="end" />
          </div>
          <p className="muted small names-claim__explain">{short ? '3–4 letter names cost' : 'names of 5 or more letters cost'} {fmt(short ? claimFeeOf('abc') : claimFeeOf('abcde'))} WIF{short ? `, longer names ${fmt(claimFeeOf('abcde'))} WIF` : `, 3–4 letter names ${fmt(claimFeeOf('abc'))} WIF`}. one-time payment. the name is minted to your wallet as an NFT.</p>
          <details className="names-claim__split"><summary>where your WIF goes</summary><div className="fee fee--compact"><FeeParts fee={claimFee} showBar kind="claim" /></div></details>
          {ok && wif !== undefined && wif < claimFee && <LowBalance need={claimFee} what={`claim ${name}.wif`} />}
          {ok && wif === undefined && <button className="btn btn--ghost btn--sm names-getwif" onClick={() => openSheet({ type: 'swap', wifOut: shortfallWif(claimFee, 0), reason: `get ${fmt(shortfallWif(claimFee, 0))} WIF to claim ${name}.wif` })}>need WIF? get {fmt(shortfallWif(claimFee, 0))} WIF</button>}
          <div className="names-claim__look">
            <NameCard size={compact ? 'sm' : 'md'} label={name} theme={look} state={state === 'soon' ? 'idle' : state} fee={LIVE && name ? claimFee : undefined} />
            <div className="names-claim__theme"><span className="field__label">card style</span><ThemePicker label={name} value={look} onChange={setPick} /></div>
          </div>
          <button className="btn btn--dark btn--lg btn--block" disabled={!ok || !!busy} onClick={claim}>{busy ? 'waiting for confirmation…' : `claim for ${fmt(name ? claimFee : claimFeeOf('abcde'))} WIF`}</button>
          <p className="tiny muted names-claim__how">your wallet asks you twice: first to allow exactly {fmt(name ? claimFee : claimFeeOf('abcde'))} WIF for the fee, then to claim. it can’t take more than that.</p>
        </>}
      </>}
    </section>
  )
}

/** " (about $1.30)" when the live price is known; nothing otherwise. */
function WifUsdNote({ wif }: { wif: number }) {
  const { usd, stale } = useWifPrice()
  if (usd === undefined || stale) return null
  return <span className="muted"> (about ${usdText(wif * usd)})</span>
}

function ClaimTab() {
  const [sp] = useSearchParams()
  const { me } = useSession()
  const { openSheet } = useStore()
  const primary = sp.get('primary') === '1'
  if (!me) return <><ClaimBox initial={sp.get('n') ?? ''} /><p className="muted small center">you’ll sign in before claiming. <button className="linkbtn" onClick={() => openSheet({ type: 'signin' })}>sign in</button></p></>
  return <>
    {primary && <p className="muted small names-primary-note">make it yours onchain: claim {sp.get('n') ?? me.handle}.wif and it becomes your main name, in one transaction. your posts, followers and badges stay as they are.</p>}
    <ClaimBox initial={sp.get('n') ?? me.handle} andPrimary={primary || !me.wifName} />
  </>
}

function MineTab() {
  const mine = useQuery({ queryKey: ['names', 'mine'], queryFn: () => api<Mine>('/names/mine') })
  const { run, busy } = useNameTx()
  const [price, setPrice] = useState<Record<string, string>>({})
  const nav = useNavigate()
  const d = mine.data
  if (mine.isLoading) return <NameSkel n={3} />
  if (!d?.names.length) return <Empty title="no .wif names yet" body="claim one and people can send you WIF at yourname.wif." mood="wow" action={<Link className="btn btn--dark btn--sm" to="/names">claim a name</Link>} />
  const setPrimary = (n: string) => run(`pri:${n}`, namePlans.setPrimary(n), h => api(`/names/${n}/primary`, { method: 'POST', json: { txHash: h } }), `${n}.wif is your primary name`)
  return (
    <>
      <ul className="names-list">
        {d.names.map(n => {
          const p = Number(price[n.name] ?? n.listing?.price ?? '')
          const fee = p * NAME_FEE_BPS / 10_000
          return (
            <li key={n.name} className="names-row is-open">
              <div className="names-row__main">
                <span className="names-row__name"><img className="names-row__art" src={nameArtUrl(n.name)} alt="" loading="lazy" /><WifName label={n.name} verified={n.primary} />{n.primary && <span className="chip-soft">primary</span>}{n.listing && <span className="chip-soft">listed</span>}</span>
                <span />
                <span className="names-row__price">{n.listing ? <Amount value={n.listing.price} size={15} /> : <span className="muted small">not listed</span>}</span>
              </div>
              <div className="names-row__actions">
                <button className="btn btn--ghost btn--sm" onClick={() => nav(`/names/${n.name}/manage`)}><Icon name="more" size={14} /> manage records</button>
                {!n.primary && !n.listing && <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => setPrimary(n.name)}>{busy === `pri:${n.name}` ? 'setting…' : 'set as primary'}</button>}
                <Link className="btn btn--ghost btn--sm" to={`/n/${n.name}`}>public page</Link>
              </div>
              {n.primary ? <p className="tiny muted">your primary name can’t be listed. set another one as primary first.</p> : (
                <div className="names-list-form">
                  <label className="field__input"><input inputMode="decimal" placeholder="price" value={price[n.name] ?? (n.listing ? String(n.listing.price) : '')} onChange={e => setPrice({ ...price, [n.name]: e.target.value.replace(/[^0-9.]/g, '') })} aria-label={`price for ${n.name}.wif`} /><span className="muted">WIF</span></label>
                  <button className="btn btn--dark btn--sm" disabled={!!busy || !(p > 0)} onClick={() => run(`list:${n.name}`, plans.nameList(n.name, p), () => api(`/names/${n.name}/list`, { method: 'POST', json: { price: p } }), `${n.name}.wif listed for ${fmt(p)} WIF`)}>{n.listing ? 'update price' : 'list'}</button>
                  {n.listing && <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => run(`del:${n.name}`, plans.nameCancel(n.name), () => api(`/names/${n.name}/list`, { method: 'DELETE' }), `${n.name}.wif delisted`)}>delist</button>}
                  {p > 0 && <span className="tiny muted">you get {fmt(p - fee)} WIF · fee {fmt(fee)} ({fmt(splitFee(fee).pot)} pot, {fmt(splitFee(fee).burn)} burned)</span>}
                  <p className="names-warn tiny"><Icon name="shield" size={12} /> selling clears this name’s records (address, avatar, X, link, bio). the buyer starts fresh.</p>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {!!d.offersIn.length && <>
        <div className="section-label"><span className="eyebrow">offers for your names</span></div>
        <ul className="names-list">{d.offersIn.map(o => (
          <li key={o.id} className="names-row"><div className="names-row__main">
            <span className="names-row__name">{o.name}.wif</span><span className="muted small">from @{o.buyer}</span><span className="names-row__price"><Amount value={o.price} size={15} /></span>
          </div>
            <p className="names-warn tiny"><Icon name="shield" size={12} /> if they buy it, the records reset.</p>
            <div className="names-row__actions"><button className="btn btn--dark btn--sm" disabled={!!busy} onClick={() => run(`acc:${o.id}`, plans.nameList(o.name, o.price), () => api(`/names/offers/${o.id}/accept`, { method: 'POST' }), `accepted. @${o.buyer} can buy ${o.name}.wif now`)}>accept (lists it for them)</button></div>
          </li>))}</ul>
      </>}
      {!!d.offersOut.length && <>
        <div className="section-label"><span className="eyebrow">your offers</span></div>
        <ul className="names-list">{d.offersOut.map(o => (
          <li key={o.id} className="names-row"><div className="names-row__main">
            <span className="names-row__name">{o.name}.wif</span><span className="muted small">open</span><span className="names-row__price"><Amount value={o.price} size={15} /></span>
          </div>
            <div className="names-row__actions"><button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => run(`wd:${o.id}`, null, () => api(`/names/offers/${o.id}`, { method: 'DELETE' }), 'offer withdrawn')}>withdraw</button></div>
          </li>))}</ul>
      </>}
    </>
  )
}

export function MarketTab() {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'new' | 'low' | 'high' | 'short'>('new')
  const { me } = useSession()
  const { openSheet, toast } = useStore()
  const { address } = useAnyAccount()
  const wif = useWifBalance(address).value
  const m = useQuery({ queryKey: ['names', 'market', q, sort], queryFn: () => api<Market>(`/names/market?sort=${sort}&q=${encodeURIComponent(q)}`) })
  const { run, busy } = useNameTx()
  const [offer, setOffer] = useState<{ name: string; price: string } | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const buy = (l: Listing) => {
    if (!me) return openSheet({ type: 'signin' })
    if (!LIVE) return toast(`buying ${l.name}.wif needs the names contract`, PREVIEW_NOTE)
    run(`buy:${l.name}`, plans.nameBuy(l.name, l.price), h => api(`/names/${l.name}/buy`, { method: 'POST', json: { txHash: h } }), `${l.name}.wif is yours once it confirms`)
  }
  const sendOffer = () => {
    if (!offer) return
    const p = Number(offer.price)
    if (!(p > 0)) return toast('enter an offer in WIF')
    run(`offer:${offer.name}`, null, () => api(`/names/${offer.name}/offers`, { method: 'POST', json: { price: p, days: 7 } }), `offer sent for ${offer.name}.wif`).then(() => setOffer(null))
  }

  return (
    <>
      <div className="names-tools">
        <label className="search-input"><Icon name="search" size={16} /><input value={q} placeholder="search .wif names" onChange={e => setQ(normalizeName(e.target.value).replace(/[^a-z0-9_]/g, ''))} /></label>
        <select value={sort} onChange={e => setSort(e.target.value as typeof sort)} aria-label="sort">
          <option value="new">newest</option><option value="low">price: low to high</option><option value="high">price: high to low</option><option value="short">shortest</option>
        </select>
      </div>
      {!!m.data?.recentSales.length && <div className="names-sales small muted">recent sales: {m.data.recentSales.slice(0, 4).map(s => `${s.name}.wif ${fmt(s.price)} WIF`).join(' · ')}</div>}
      {m.isLoading && <NameSkel n={5} />}
      {m.data?.listings.length === 0 && <Empty title="nothing for sale right now" body={q ? `no listings matching “${q}”.` : 'list one of your names and it shows up here.'} />}
      <ul className="names-list">
        {m.data?.listings.map(l => (
          <li key={l.name} className={`names-row ${open === l.name ? 'is-open' : ''}`}>
            <button className="names-row__main" onClick={() => setOpen(open === l.name ? null : l.name)} aria-expanded={open === l.name}>
              <span className="names-row__name"><img className="names-row__art" src={nameArtUrl(l.name)} alt="" loading="lazy" />{l.name}<span className="wifname__tld">.wif</span>{l.name.length <= 4 && <span className="chip-soft">short</span>}{l.forYou && <span className="chip-soft">offer for you</span>}</span>
              <span className="names-row__seller">{l.seller && <><Avatar handle={l.seller.handle} size={20} /> <span className="muted small">{at(l.seller.handle)}</span></>}</span>
              <span className="names-row__price"><Amount value={l.price} size={15} /></span>
            </button>
            {open === l.name && (
              <div className="names-row__more">
                <img className="names-row__card" src={nameArtUrl(l.name)} alt={`${l.name}.wif name card, rendered onchain`} />
                <dl className="names-fee">
                  <div><dt>price</dt><dd>{fmt(l.price)} WIF</dd></div>
                  <div><dt>fee ({m.data!.feeBps / 100}%)</dt><dd>{fmt(l.fee.total)} WIF · {l.fee.treasury > 0 ? `${fmt(l.fee.treasury)} treasury, ` : ''}{fmt(l.fee.pot)} weekly community pot, {fmt(l.fee.burn)} burned</dd></div>
                  <div><dt>seller gets</dt><dd>{fmt(l.fee.sellerGets)} WIF</dd></div>
                  {l.offers > 0 && <div><dt>offers</dt><dd>{l.offers} · top {fmt(l.topOffer ?? 0)} WIF</dd></div>}
                </dl>
                <p className="names-warn small"><Icon name="shield" size={14} /> {l.mine ? 'when it sells, the records reset: your address, avatar, X, link and bio are cleared.' : 'records reset when you buy: the seller’s address, avatar, X, link and bio are cleared. set your own after.'}</p>
                {l.mine ? <Link className="btn btn--ghost btn--sm" to="/names?tab=mine">manage your listing</Link> : <>
                  {wif !== undefined && wif < l.price && <LowBalance need={l.price} what={`buy ${l.name}.wif`} />}
                  <div className="names-row__actions">
                    <button className="btn btn--dark" disabled={!!busy} onClick={() => buy(l)}>{busy === `buy:${l.name}` ? 'waiting for confirmation…' : `buy for ${fmt(l.price)} WIF`}</button>
                    <button className="btn btn--ghost" onClick={() => me ? setOffer({ name: l.name, price: String(Math.round(l.price * 0.8)) }) : openSheet({ type: 'signin' })}>make an offer</button>
                  </div>
                  {offer?.name === l.name && (
                    <div className="names-offer">
                      <label className="field__input"><input inputMode="decimal" value={offer.price} onChange={e => setOffer({ ...offer, price: e.target.value.replace(/[^0-9.]/g, '') })} aria-label="offer in WIF" /><span className="muted">WIF</span></label>
                      <button className="btn btn--dark btn--sm" disabled={!!busy} onClick={sendOffer}>send offer</button>
                      <button className="linkbtn" onClick={() => setOffer(null)}>cancel</button>
                    </div>
                  )}
                  <TxSteps pull={l.price} action={`buy ${l.name}.wif`} />
                </>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}
