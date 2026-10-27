import { profilePath } from '../lib/paths'
import { useAnyAccount } from '../auth/privyBridge'
/** Manage a .wif name's records (setAddr + setText via one multicall) and the public name page (marv.wif). */
import { at } from '../lib/format'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Address } from 'viem'
import { api, type ApiUser } from '../api/client'
import { useSession } from '../api/session'
import { MAX_TEXT_BYTES, bytesOf, namePlans, normalizeName, recordErrors, type TextKey } from '../lib/names'
import { useStore } from '../state/store'
import { PageHead } from '../components/Shell'
import { Amount, Avatar } from '../components/Bits'
import { Icon } from '../components/Icon'
import { NameCard, ThemePicker, WifName, defaultThemeOf } from '../components/WifName'
import { Empty } from '../companion/Companion'
import { NameCardSkel } from '../components/Delight'
import { companion } from '../lib/companion'
import { RESET_WARNING, useNameTx } from './Names'

type Records = { address: string | null; avatar: string | null; x: string | null; url: string | null; bio: string | null; updatedAt: number | null }
type NameView =
  | { name: string; display: string; claimed: false; check?: { available: boolean; reason?: string; claimFee: number } }
  | { name: string; display: string; claimed: true; minted: boolean; theme: number; since: number; tokenId: string; owner?: ApiUser; primary: boolean; mine: boolean
      address: string | null; source: string; records: Records; listing: { price: number } | null; live: boolean }
const short = (a?: string | null) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''

export function ManageName() {
  const label = normalizeName(useParams().name ?? '')
  const q = useQuery({ queryKey: ['names', 'view', label], queryFn: () => api<NameView>(`/names/${label}`) })
  const { address } = useAnyAccount()
  const { run, busy } = useNameTx()
  const nav = useNavigate()
  const [f, setF] = useState<Record<TextKey | 'address', string>>({ address: '', avatar: '', x: '', url: '', bio: '' })
  const d = q.data
  useEffect(() => { if (d?.claimed) setF({ address: d.records.address ?? '', avatar: d.records.avatar ?? '', x: d.records.x ?? '', url: d.records.url ?? '', bio: d.records.bio ?? '' }) }, [d])
  const errs = useMemo(() => recordErrors(f), [f])
  const [look, setLook] = useState<1 | 2 | null>(null)
  if (q.isLoading) return <NameCardSkel />
  if (!d?.claimed || !d.mine) return <Empty title={`you don’t hold ${label}.wif`} mood="oops" action={<Link className="btn btn--dark btn--sm" to={`/names?n=${label}`}>check it</Link>} />
  const changed = (k: keyof typeof f) => (f[k] || '') !== ((d.records as Records)[k as keyof Records] ?? '')
  const dirty = (['address', 'avatar', 'x', 'url', 'bio'] as const).some(changed)
  const save = async () => {
    const rec: Partial<Record<TextKey, string>> = {}
    for (const k of ['avatar', 'x', 'url', 'bio'] as const) if (changed(k)) rec[k] = k === 'x' ? f.x.replace(/^@/, '') : f[k].trim()
    const addr = changed('address') ? ((f.address.trim() || null) as Address | null) : undefined
    const ok = await run(`rec:${label}`, namePlans.setRecords(label, rec, addr), () => api(`/names/${label}/records`, { method: 'PUT', json: { ...f, x: f.x.replace(/^@/, '') } }), `${label}.wif records saved`)
    if (ok) { companion.say('records saved', 'happy'); q.refetch() }
  }
  const bioBytes = bytesOf(f.bio)
  const def = defaultThemeOf(label)
  const stored: 1 | 2 = d.theme === 1 || d.theme === 2 ? d.theme : def
  const shown = look ?? stored
  const saveLook = async () => {
    const t = shown === def ? 0 : shown
    const ok = await run(`theme:${label}`, namePlans.setTheme(label, t), h => api(`/names/${label}/theme`, { method: 'POST', json: { theme: t, txHash: h } }), `${label}.wif card is ${shown === 1 ? 'white' : 'green'}`)
    if (ok) { setLook(null); q.refetch() }
  }
  return (
    <div className="names-page">
      <PageHead title={`${label}.wif`} back sub="records live onchain on the name: setAddr and setText." />
      <NameCard label={label} theme={shown} state="yours" owner={d.address ? short(d.address) : null} />
      <section className="card manage-name">
        <div className="names-claim__theme"><span className="field__label">card look</span><ThemePicker label={label} value={shown} onChange={setLook} disabled={!!busy} />
          <span className="tiny muted">the look is saved on the name with setTheme and stays with it if you sell.</span>
          <button className="btn btn--ghost btn--sm" disabled={shown === stored || !!busy} onClick={saveLook}>{shown === stored ? 'this is your card' : `use the ${shown === 1 ? 'white' : 'green'} card`}</button></div>

        <Field k="address" label="address" hint={`where ${label}.wif sends. empty = the wallet that holds it${d.address ? ` (${short(d.address)})` : ''}.`} f={f} setF={setF} errs={errs} placeholder="0x…" action={address ? <button className="linkbtn" onClick={() => setF({ ...f, address })}>use my wallet</button> : null} />
        <Field k="avatar" label="avatar" hint="an upload, https:// or ipfs:// link" f={f} setF={setF} errs={errs} placeholder="https://…" />
        <Field k="x" label="X" hint="your X handle" f={f} setF={setF} errs={errs} placeholder="@handle" />
        <Field k="url" label="link" hint="https:// only" f={f} setF={setF} errs={errs} placeholder="https://…" />
        <label className="field">
          <span className="field__label">bio <span className={`tiny ${bioBytes > MAX_TEXT_BYTES ? 'error' : 'muted'}`}>{bioBytes}/{MAX_TEXT_BYTES} bytes</span></span>
          <textarea className="textarea" rows={3} value={f.bio} onChange={e => setF({ ...f, bio: e.target.value })} aria-invalid={!!errs.bio} placeholder="a line about you" />
          {errs.bio && <span className="tiny error">bios are up to {MAX_TEXT_BYTES} bytes (emoji count as 4)</span>}
        </label>
        <p className="names-warn tiny"><Icon name="shield" size={12} /> {RESET_WARNING}</p>
        <button className="btn btn--dark btn--lg btn--block" disabled={!dirty || !!busy || Object.keys(errs).length > 0} onClick={save}>{busy ? 'waiting for confirmation…' : dirty ? 'save records in one transaction' : 'no changes'}</button>
        <div className="row-gap"><button className="linkbtn" onClick={() => nav(`/n/${label}`)}>view public page</button></div>
      </section>
    </div>
  )
}

function Field({ k, label, hint, f, setF, errs, placeholder, action }: { k: 'address' | 'avatar' | 'x' | 'url'; label: string; hint: string; f: Record<string, string>; setF: (v: Record<TextKey | 'address', string>) => void; errs: Record<string, string | undefined>; placeholder: string; action?: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label} {action}</span>
      <span className="field__input"><input value={f[k]} placeholder={placeholder} onChange={e => setF({ ...f, [k]: e.target.value } as Record<TextKey | 'address', string>)} aria-invalid={!!errs[k]} autoCapitalize="none" spellCheck={false} /></span>
      <span className={`tiny ${errs[k] ? 'error' : 'muted'}`}>{errs[k] ?? hint}</span>
    </label>
  )
}

export function PublicName() {
  const label = normalizeName(useParams().name ?? '')
  const q = useQuery({ queryKey: ['names', 'view', label], queryFn: () => api<NameView>(`/names/${label}`) })
  const { me } = useSession()
  const { openSheet } = useStore()
  const d = q.data
  if (q.isLoading) return <NameCardSkel />
  if (!d) return <Empty title="couldn’t load that name" mood="oops" />
  if (!d.claimed) return (
    <div className="names-page">
      <PageHead title={`${label}.wif`} back />
      <NameCard size="lg" label={label} state={d.check?.available ? 'available' : d.check?.reason === 'reserved' ? 'reserved' : 'idle'} fee={d.check?.claimFee} />
      <Empty title={d.check?.available ? `${label}.wif is unclaimed` : `${label}.wif can’t be claimed`} body="unclaimed names resolve to no wallet, so nothing can be sent to it." action={d.check?.available ? <Link className="btn btn--dark btn--sm" to={`/names?n=${label}`}>claim it</Link> : undefined} />
    </div>
  )
  const r = d.records
  return (
    <div className="names-page pubname">
      <PageHead title={`${label}.wif`} back />
      <NameCard size="lg" label={label} theme={d.theme} state={me && d.owner && me.handle === d.owner.handle ? 'yours' : 'taken'} owner={d.owner && d.address ? short(d.address) : null} />
      <section className="card pubname__card">
        <div className="pubname__head">
          {r.avatar?.startsWith('/uploads/') ? <img className="pubname__avatar" src={r.avatar} alt="" /> : d.owner ? <Avatar handle={d.owner.handle} size={56} /> : null}
          <div>
            <WifName label={label} verified={d.primary} size="lg" link={false} />
            {d.owner && <Link to={profilePath(d.owner.handle)} className="muted small">{at(d.owner.handle)}</Link>}
          </div>
        </div>
        {r.bio && <p className="pubname__bio">{r.bio}</p>}
        <dl className="names-fee">
          <div><dt>resolves to</dt><dd className="mono">{d.address ? short(d.address) : 'no wallet'}{d.address && <button className="linkbtn" onClick={() => navigator.clipboard?.writeText(d.address!)}>copy</button>}</dd></div>
          <div><dt>resolved by</dt><dd>{d.source === 'chain' ? 'resolve() onchain' : 'Wifly mirror (contract not live yet)'}</dd></div>
          {r.x && <div><dt>X</dt><dd><a href={`https://x.com/${r.x}`} target="_blank" rel="noreferrer">@{r.x}</a></dd></div>}
          {r.url && <div><dt>link</dt><dd><a href={r.url} target="_blank" rel="noreferrer noopener">{r.url.replace(/^https:\/\//, '')}</a></dd></div>}
          <div><dt>held since</dt><dd>{new Date(d.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}{d.minted ? '' : ' · not minted yet'}</dd></div>
        </dl>
        <div className="names-row__actions">
          {!d.mine && <button className="btn btn--dark" disabled={!d.address} onClick={() => me ? openSheet({ type: 'tip', to: `${label}.wif` }) : openSheet({ type: 'signin' })}><Icon name="tip" size={16} /> send WIF to {label}.wif</button>}
          {d.mine && <Link className="btn btn--dark" to={`/names/${label}/manage`}>manage records</Link>}
          {d.listing && !d.mine && <Link className="btn btn--ghost" to={`/names?tab=market`}>for sale · <Amount value={d.listing.price} size={14} /></Link>}
        </div>
        {!d.address && <p className="tiny muted">this name resolves to no wallet yet, so it can’t receive WIF.</p>}
      </section>
    </div>
  )
}
