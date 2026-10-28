/** /settings/accounts: owner-only accounts list (server gate: ADMIN_ADDRESSES; anyone else gets the plain 404 page). */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence } from 'motion/react'
import { api, ApiError } from '../api/client'
import { PageHead } from '../components/Shell'
import { RemoveAccountSheet } from '../components/AccountRemove'
import { useStore } from '../state/store'
import { useSession } from '../api/session'
import { NotFound } from './NotFound'

type Row = { id: number; handle: string | null; methods: string[]; onboarded: boolean; wallet: string | null; x: string | null; email: string | null; createdAt: number; posts: number }
type Filter = 'all' | 'unfinished' | 'guests'

type Owner = { address: string; account: { id: number; handle: string | null; name: string | null; kind: string; guest: boolean; joined: number } | null }
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).toLowerCase()

export function AdminAccounts() {
  const [filter, setFilter] = useState<Filter>('all')
  const [rm, setRm] = useState<Row | null>(null)
  const { toast } = useStore()
  const qc = useQueryClient()
  const { admin, ready } = useSession()
  // only owners ask the server, so everyone else sees the plain 404 page with no failed request
  const q = useQuery({ queryKey: ['admin', 'accounts', filter], queryFn: () => api<{ accounts: Row[] }>(`/admin/accounts?filter=${filter}`), retry: false, enabled: admin })
  if (ready && !admin) return <NotFound />
  if (q.error && (q.error as ApiError).status === 404) return <NotFound />
  if (q.error && (q.error as ApiError).status === 401) return <NotFound />
  const rows = q.data?.accounts ?? []
  return (
    <>
      <PageHead title="accounts" back />
      <div className="admin-accts settings-page">
        <WalletLookup />
        <div className="admin-accts__filters" role="tablist">
          {(['all', 'unfinished', 'guests'] as Filter[]).map(f => <button key={f} role="tab" aria-selected={filter === f} className={`chip chip--sm ${filter === f ? 'chip--on' : ''}`} onClick={() => setFilter(f)}>{f}</button>)}
        </div>
        {q.isLoading ? <p className="muted small">loading accounts…</p> : !rows.length ? <p className="muted small">no accounts here.</p> : (
          <ul className="admin-accts__list">
            {rows.map(r => (
              <li key={r.id} className="admin-accts__row">
                <div className="admin-accts__who">
                  <span>{r.handle ? `@${r.handle}` : 'unfinished'}</span>
                  {!r.onboarded && <span className="admin-accts__tag admin-accts__tag--todo">onboarding not done</span>}
                  {r.methods.map(m => <span key={m} className="admin-accts__tag">{m}</span>)}
                </div>
                <button className="btn btn--ghost btn--sm" onClick={() => setRm(r)}>remove</button>
                <div className="admin-accts__meta">
                  {r.wallet && <span>wallet {r.wallet.toLowerCase()}</span>}
                  {r.x && <span>x @{r.x}</span>}
                  {r.email && <span>email {r.email}</span>}
                  <span>{r.posts} {r.posts === 1 ? 'post' : 'posts'}</span>
                  <span>joined {when(r.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <AnimatePresence>
        {rm && <RemoveAccountSheet mode="admin" handle={rm.handle} onClose={() => setRm(null)} onConfirm={async typed => {
          await api(`/admin/accounts/${rm.id}/remove`, { method: 'POST', json: { confirm: typed } })
          setRm(null); toast('account removed'); void qc.invalidateQueries({ queryKey: ['admin'] })
        }} />}
      </AnimatePresence>
    </>
  )
}

/** which account owns a wallet address (server: admin only, read-only, audited) */
function WalletLookup() {
  const [addr, setAddr] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<Owner | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const a = addr.trim().toLowerCase()
  const valid = /^0x[0-9a-f]{40}$/.test(a)
  const find = async () => {
    if (!valid || busy) return
    setBusy(true); setErr(null); setRes(null)
    try { setRes(await api<Owner>(`/admin/wallet/${a}`)) } catch (e) { setErr(e instanceof ApiError && e.status === 400 ? 'that isn’t a wallet address' : 'couldn’t look that up. try again') } finally { setBusy(false) }
  }
  return (
    <form className="admin-lookup" onSubmit={e => { e.preventDefault(); void find() }}>
      <label className="small muted" htmlFor="admin-lookup-addr">who owns this wallet</label>
      <div className="admin-lookup__row">
        <input id="admin-lookup-addr" className="field__input mono" placeholder="0x…" value={addr} onChange={e => { setAddr(e.target.value); setRes(null); setErr(null) }} autoComplete="off" spellCheck={false} />
        <button type="submit" className="btn btn--dark btn--sm" disabled={!valid || busy}>{busy ? 'looking…' : 'look up'}</button>
      </div>
      {err && <p className="small muted" role="alert">{err}</p>}
      {res && (res.account
        ? <p className="admin-lookup__hit small">{res.account.handle ? <Link to={`/@${res.account.handle}`}>@{res.account.handle}</Link> : <span>unfinished account</span>}
            <span className="muted"> · {res.account.kind} wallet{res.account.guest ? ' · guest' : ''} · account {res.account.id} · joined {when(res.account.joined)}</span></p>
        : <p className="small muted">no account has this wallet.</p>)}
    </form>
  )
}
