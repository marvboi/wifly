import { NAMES_ADDRESS } from '../config'
/** Free @name ↔ .wif: the "make it yours onchain" button, the claim nudge for free @names, and the gentle bump notice + rename step. */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { adoptUser, api, type ApiUser } from '../api/client'
import { useSession } from '../api/session'
import { useStore } from '../state/store'
import { HandleField, useHandleCheck } from './HandleField'
import { Amount } from './Bits'
import { Icon } from './Icon'
import { userError } from '../lib/txError'

export type Identity = {
  handle: string; wifName: string | null
  bump: { handle: string; renameBy: number; since: number } | null
  nudge: { name: string; display: string; claimFee: number; live: boolean } | null
}

export function useIdentity() {
  const { me } = useSession()
  return useQuery({ queryKey: ['identity', me?.handle], queryFn: () => api<Identity>('/me/identity'), enabled: !!me && !!me.onboarded, staleTime: 30_000 })
}

const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()
const claimUrl = (n: string) => `/names?n=${encodeURIComponent(n)}&primary=1`

/** Own profile / settings, free @name only. Claims name.wif and sets it primary in one multicall. */
export function MakeItYours({ block }: { block?: boolean }) {
  const id = useIdentity().data
  const nav = useNavigate()
  const { closeSheet } = useStore()
  if (!id?.nudge) return null
  return (
    <button className={`btn btn--dark ${block ? 'btn--block' : ''}`} onClick={() => { closeSheet(); nav(claimUrl(id.nudge!.name)) }}>
      <Icon name="sparkle" size={16} /> make it yours onchain
    </button>
  )
}

/** "Claim name.wif before someone else does." Free @names are not reservations: anyone can claim the .wif. */
export function NameNudge() {
  const id = useIdentity().data
  const nav = useNavigate()
  const key = id?.nudge ? `wifly:nudge:${id.nudge.name}` : ''
  const [hidden, setHidden] = useState(() => !!key && localStorage.getItem(key) === '1')
  if (!NAMES_ADDRESS) return null // claiming isn't open yet: no nudge until it is
  if (!id?.nudge || hidden || (key && localStorage.getItem(key) === '1')) return null
  const n = id.nudge
  return (
    <section className="idcard" aria-label="claim your .wif">
      <div className="idcard__copy">
        <div className="strong">claim {n.display} before someone else does</div>
        <div className="muted small">your @{n.name} is free and lives on wifly. {n.display} is the onchain version: it points to your wallet, and anyone can claim it first. claim fee <Amount value={n.claimFee} size={13} /></div>
      </div>
      <div className="idcard__actions">
        <button className="btn btn--dark btn--sm" onClick={() => nav(claimUrl(n.name))}>claim {n.display}</button>
        <button className="btn btn--text btn--sm" onClick={() => { localStorage.setItem(key, '1'); setHidden(true) }}>not now</button>
      </div>
    </section>
  )
}

/** Someone claimed the .wif matching your free @name. Gentle notice + a rename step with a grace period. */
export function BumpNotice() {
  const id = useIdentity().data
  const { setMe } = useSession()
  const { toast } = useStore()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const { check } = useHandleCheck(to)
  if (!id?.bump) return null
  const b = id.bump
  const save = async () => {
    setBusy(true)
    try {
      const r = await api<{ me: ApiUser }>('/me', { method: 'PATCH', json: { handle: to } })
      adoptUser({ ...r.me, you: true }); setMe(r.me as never)
      qc.invalidateQueries(); toast(`you’re @${r.me.handle} now`, 'your posts, followers and badges came with you')
    } catch (e) { toast('couldn’t rename', userError(e)) } finally { setBusy(false) }
  }
  return (
    <section className="idcard idcard--notice" aria-label="your @name is changing">
      <div className="idcard__copy">
        <div className="strong">someone claimed {b.handle}.wif onchain</div>
        <div className="muted small">a .wif owner gets the matching @name, so <b>@{b.handle}</b> moves to them on {day(b.renameBy)}. nothing else changes: your posts, followers and badges stay with you. only your handle changes. pick a new one before then, or we’ll give you one you can change any time.</div>
      </div>
      {open ? (
        <div className="idcard__rename">
          <HandleField value={to} onChange={setTo} autoFocus />
          <button className="btn btn--dark btn--sm" disabled={!check?.available || busy} onClick={save}>{busy ? 'saving…' : `switch to @${to || '…'}`}</button>
        </div>
      ) : (
        <div className="idcard__actions"><button className="btn btn--dark btn--sm" onClick={() => setOpen(true)}>pick a new @name</button></div>
      )}
    </section>
  )
}
