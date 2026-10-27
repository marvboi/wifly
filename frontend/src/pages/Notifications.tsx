import { profilePath } from '../lib/paths'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { api, relTime, type Notif } from '../api/client'
import { useSession } from '../api/session'
import { useNotifications } from '../api/hooks'
import { useStore } from '../state/store'
import { getDrop } from '../api/client'
import { users } from '../state/registry'
import { Amount, Avatar } from '../components/Bits'
import { PlusMark } from '../components/BrandSlots'
import { PageHead } from '../components/Shell'
import { Mascot } from '../components/Mascot'
import { Icon, type IconName } from '../components/Icon'
import { Sentinel } from '../components/Social'
import { Blank, SkelRows } from '../components/Delight'

const iconFor: Record<Notif['kind'], IconName> = { like: 'heart', pass: 'repost', reply: 'reply', quote: 'quote', follow: 'user', mention: 'reply', tip: 'tip', name_offer: 'at', name_offer_accepted: 'check', handle_bump: 'info' }
const verb: Record<Notif['kind'], string> = {
  like: 'liked your drop', pass: 'passed your drop on', reply: 'replied to you', quote: 'quoted your drop',
  follow: 'followed you', mention: 'mentioned you', tip: 'tipped your drop · it’s in your wallet',
  name_offer: 'made an offer on your name', name_offer_accepted: 'accepted your offer. the name is listed for you',
  handle_bump: 'claimed a .wif that matches your @name',
}
type Filter = 'all' | 'mentions' | 'wif'
const inFilter = (n: Notif, f: Filter) => f === 'all' || (f === 'mentions' ? ['reply', 'mention', 'quote'].includes(n.kind) : n.kind === 'tip')

function who(n: Notif) {
  const [a, b] = n.actors
  const name = (h: string) => users[h]?.name ?? h
  if (!a) return null
  const first = <><b>{name(a.handle)}</b>{users[a.handle]?.plus && <PlusMark size={14} />}</>
  if (n.count <= 1) return first
  if (n.count === 2 && b) return <>{first} and <b>{name(b.handle)}</b></>
  return <>{first} and {n.count - 1} others</>
}

function Row({ n }: { n: Notif }) {
  const drop = n.drop ? getDrop(n.drop.id) : null
  const target = n.kind === 'follow' ? profilePath(n.actors[0]?.handle ?? 'you') : n.kind === 'name_offer' ? '/names?tab=mine' : n.kind === 'name_offer_accepted' ? `/names?q=${String(n.meta.name ?? '')}` : n.kind === 'handle_bump' ? '/@you' : drop ? `/post/${drop.id}` : '#'
  const showText = drop && (n.kind === 'reply' || n.kind === 'mention' || n.kind === 'quote')
  return (
    <li className={`notif ${n.read ? '' : 'is-unread'}`}>
      <Link to={target} className="notif__link">
        <span className={`notif__icon notif__icon--${n.kind}`}><Icon name={iconFor[n.kind]} size={18} fill={n.kind === 'like'} /></span>
        <div className="notif__main">
          <div className="notif__faces">{n.actors.slice(0, 6).map(a => <Avatar key={a.handle} handle={a.handle} size={32} />)}</div>
          <p className="notif__line">{who(n)} {verb[n.kind]}<span className="muted"> · {relTime(n.createdAt)}</span></p>
          {drop && !showText && drop.text && <p className="notif__quote muted clamp-2">{drop.text}</p>}
          {showText && <p className="notif__reply">{drop.text}</p>}
        </div>
        {(n.kind === 'name_offer' || n.kind === 'name_offer_accepted') && typeof n.meta.price === 'number' && <span className="notif__amt">@{String(n.meta.name)} · <Amount value={n.meta.price} size={14} /></span>}
        {n.kind === 'handle_bump' && <span className="notif__amt small">@{String(n.meta.handle)} moves to them {typeof n.meta.renameBy === 'number' ? new Date(n.meta.renameBy).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'soon'}. your posts, followers and badges stay. pick a new @name</span>}
        {n.kind === 'tip' && typeof n.meta.amount === 'number' && <span className="notif__amt">+<Amount value={n.meta.amount} size={14} /></span>}
      </Link>
    </li>
  )
}

export function Notifications() {
  const { me, ready, clearUnread } = useSession()
  const { openSheet } = useStore()
  const [filter, setFilter] = useState<Filter>('all')
  const q = useNotifications(!!me)
  const qc = useQueryClient()
  const items = (q.data?.pages ?? []).flatMap(p => p.items)
  const hasUnread = items.some(i => !i.read)
  useEffect(() => {
    if (!me || !hasUnread) return
    const t = setTimeout(() => { api('/notifications/read', { method: 'POST' }).then(() => { clearUnread(); qc.invalidateQueries({ queryKey: ['me'] }) }).catch(() => {}) }, 1500)
    return () => clearTimeout(t)
  }, [me, hasUnread, clearUnread, qc])

  if (ready && !me) {
    return (
      <>
        <PageHead title="notifications" />
        <div className="empty empty--card">
          <Mascot size={64} />
          <p className="strong">likes, replies, follows and tips land here.</p>
          <p className="muted small">sign in and you’ll see who liked, replied to, followed or tipped you.</p>
          <button className="btn btn--dark btn--sm" onClick={() => openSheet({ type: 'signin' })}>sign in</button>
        </div>
      </>
    )
  }
  const list = items.filter(n => inFilter(n, filter))
  return (
    <>
      <PageHead title="notifications" />
      <div className="tabs" role="tablist">
        {([['all', 'all'], ['mentions', 'replies & mentions'], ['wif', 'WIF in']] as [Filter, string][]).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={filter === id} className={`tab ${filter === id ? 'is-on' : ''}`} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      {q.isLoading && <SkelRows n={4} />}
      {q.isSuccess && list.length === 0 && <Blank mood={filter === 'all' ? 'calm' : 'think'} title="all quiet" body={filter === 'all' ? 'drop something and say hi. replies, tips and follows land here.' : 'nothing here yet.'} />}
      <ul className="notifs">{list.map(n => <Row key={n.id} n={n} />)}</ul>
      {list.length > 0 && <Sentinel active={!!q.hasNextPage} onMore={() => { if (!q.isFetchingNextPage) q.fetchNextPage() }} />}
    </>
  )
}
