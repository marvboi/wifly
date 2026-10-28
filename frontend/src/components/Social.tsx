/** Social building blocks: rich text, images, quote embeds, follow buttons, who-to-follow, trending, infinite scroll. */
import { postPath, profilePath } from '../lib/paths'
import { motion, AnimatePresence } from 'motion/react'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, adoptUser, followUser, type ApiUser } from '../api/client'
import { useSession, useUser } from '../api/session'
import { useStore } from '../state/store'
import type { Post } from '../state/registry'
import { users } from '../state/registry'
import { compact, at } from '../lib/format'
import { Avatar } from './Bits'
import { PlusMark } from './BrandSlots'
import { Icon } from './Icon'

const TOKEN = /(#[\p{L}\p{N}_]{1,50})|(@[A-Za-z0-9_]{3,20})|(https?:\/\/[^\s]+)/gu

/** Linkified drop text: #tags go to search, @handles to profiles, urls open in a new tab. */
export function RichText({ text, className = 'post__text' }: { text: string; className?: string }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0
    if (i > last) parts.push(text.slice(last, i))
    const [all, tag, mention, url] = m
    const stop = (e: React.MouseEvent) => e.stopPropagation()
    if (tag) parts.push(<Link key={i} className="rt-link" to={`/search?q=${encodeURIComponent(tag.toLowerCase())}`} onClick={stop}>{tag}</Link>)
    else if (mention) parts.push(<Link key={i} className="rt-link" to={profilePath(mention.slice(1))} onClick={stop}>{mention}</Link>)
    else if (url) parts.push(<a key={i} className="rt-link" href={url} target="_blank" rel="noreferrer noopener" onClick={stop}>{url.replace(/^https?:\/\//, '').slice(0, 40)}{url.length > 48 ? '…' : ''}</a>)
    else parts.push(all)
    last = i + all.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <p className={className}>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</p>
}

// Image boxes are reserved before the file loads, so the feed never jumps: new uploads carry their size in the
// name ("<id>--<w>x<h>.png"); older ones are remembered here after their first load (and sit in a 4:3 box until then).
const SIZE_IN_NAME = /--(\d{1,5})x(\d{1,5})\.(png|jpg|gif|webp)$/
const DIMS_KEY = 'wifly_imgdims'
let dimsCache: Record<string, [number, number]> | null = null
function knownDims(src: string): [number, number] | undefined {
  const m = SIZE_IN_NAME.exec(src)
  if (m && +m[1] > 0 && +m[2] > 0) return [+m[1], +m[2]]
  if (!dimsCache) { try { dimsCache = JSON.parse(localStorage.getItem(DIMS_KEY) || '{}') } catch { dimsCache = {} } }
  return dimsCache![src]
}
function rememberDims(src: string, w: number, h: number) {
  if (SIZE_IN_NAME.test(src) || !w || !h) return
  const c = dimsCache ?? {}
  c[src] = [w, h]
  const keys = Object.keys(c)
  for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete c[k] // keep the newest 300
  dimsCache = c
  try { localStorage.setItem(DIMS_KEY, JSON.stringify(c)) } catch { /* storage full or off */ }
}

export function DropImage({ src, alt = '' }: { src: string; alt?: string }) {
  const [dims, setDims] = useState(() => knownDims(src))
  return (
    <div className={`drop-img drop-img--box${dims ? '' : ' drop-img--guess'}`} style={dims ? { aspectRatio: `${dims[0]} / ${dims[1]}` } : undefined}>
      <img src={src} alt={alt} loading="lazy" decoding="async" width={dims?.[0]} height={dims?.[1]}
        onLoad={e => { const i = e.currentTarget; rememberDims(src, i.naturalWidth, i.naturalHeight); if (!dims) setDims([i.naturalWidth, i.naturalHeight]) }} />
    </div>
  )
}

/** A quoted drop, one level deep. */
export function QuoteEmbed({ post, missing }: { post?: Post | null; missing?: boolean }) {
  const nav = useNavigate()
  if (missing || !post) return <div className="quote quote--gone small muted">this drop was deleted.</div>
  if (post.deleted) return <div className="quote quote--gone small muted">this drop was deleted.</div>
  const u = users[post.author]
  return (
    <div className="quote" role="link" tabIndex={0} onClick={e => { e.stopPropagation(); nav(postPath(post.id, post.author)) }}
      onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); nav(postPath(post.id, post.author)) } }}>
      <div className="quote__head">
        <Avatar handle={post.author} size={20} />
        <span className="strong small">{u?.name ?? post.author}</span>{u?.plus && <PlusMark size={14} />}
        <span className="muted small">@{post.author} · {post.time}</span>
      </div>
      <RichText text={post.text} className="quote__text" />
      {post.image && <DropImage src={post.image} />}
    </div>
  )
}

/** Ask for sign-in before any write. Returns true when the caller may go ahead. */
export function useGate() {
  const { me } = useSession()
  const { openSheet } = useStore()
  return (reason?: string) => { if (me) return true; openSheet({ type: 'signin', reason }); return false }
}

/**
 * Writes that need a real account (like, pass it on, reply, follow …): signed out opens sign-in, a guest opens the
 * link sheet and the action runs right after linking, everyone else runs it now.
 */
export function useNeedLink() {
  const { me, guest } = useSession()
  const { openSheet } = useStore()
  const nav = useNavigate()
  return (run: () => void, reason?: string) => {
    if (!me) { openSheet({ type: 'signin', reason }); return }
    if (me.needsHandle) { nav(`/welcome${me.renaming ? '?step=you' : ''}`); return }
    if (guest) { openSheet({ type: 'link', then: run }); return }
    run()
  }
}

export function FollowButton({ handle, size = 'md' }: { handle: string; size?: 'sm' | 'md' }) {
  const u = useUser(handle)
  const need = useNeedLink()
  const { toast } = useStore()
  if (!u || u.you) return null
  const on = !!u.youFollow
  return (
    <motion.button whileTap={{ scale: 0.95 }} className={`btn ${size === 'sm' ? 'btn--sm' : ''} ${on ? 'btn--ghost' : 'btn--dark'} follow-btn`}
      onClick={e => { e.preventDefault(); e.stopPropagation(); need(() => { followUser(handle, !on).catch(err => toast('couldn’t update follow', err.message)) }, 'sign in to follow people') }}>
      {on ? <span className="follow-btn__on">following</span> : 'follow'}
    </motion.button>
  )
}

export function UserRow({ user, reason }: { user: ApiUser; reason?: string }) {
  return (
    <Link to={profilePath(user.handle)} className="urow">
      <Avatar handle={user.handle} size={40} />
      <span className="urow__main">
        <span className="urow__name"><span className="clamp-1">{user.name}</span>{user.plus && <PlusMark size={14} />}</span>
        <span className="muted small clamp-1">{at(user.handle)}{reason ? ` · ${reason}` : user.followsYou ? ' · follows you' : ''}</span>
        {!reason && user.bio && <span className="small urow__bio">{user.bio}</span>}
      </span>
      <FollowButton handle={user.handle} size="sm" />
    </Link>
  )
}

/** Placeholder rows shaped exactly like the real ones (same classes, invisible text), so nothing moves when data lands. */
function UserRowSkel({ i }: { i: number }) {
  return (
    <div className="urow urow--skel" aria-hidden="true">
      <span className="skel skel--circle" />
      <span className="urow__main">
        <span className="urow__name"><span className="ph" style={{ width: `${46 + ((i * 17) % 24)}%` }}>{'\u00a0'}</span></span>
        <span className="muted small"><span className="ph" style={{ width: `${62 + ((i * 11) % 20)}%` }}>{'\u00a0'}</span></span>
      </span>
      <span className="btn btn--sm btn--dark follow-btn ph-btn">follow</span>
    </div>
  )
}

export function WhoToFollow({ limit = 3, title = 'people to follow' }: { limit?: number; title?: string }) {
  const { me, ready } = useSession()
  // keep the last list while the signed-in copy loads, instead of blanking the card for a moment
  const q = useQuery({ queryKey: ['suggest', limit, me?.handle], placeholderData: keepPreviousData, enabled: ready, queryFn: async () => {
    const r = await api<{ users: (ApiUser & { reason: string })[] }>(`/suggest/users?limit=${limit}`)
    r.users.forEach(adoptUser); return r.users
  } })
  if (!q.data && q.isError) return null
  if (!q.data) return (
    <section className="side-card" aria-busy="true" aria-label={`${title}, loading`}>
      <h3 className="side-card__title">{title}</h3>
      {Array.from({ length: limit }, (_, i) => <UserRowSkel key={i} i={i} />)}
      <span className="side-card__more small ph" aria-hidden="true">see more people</span>
    </section>
  )
  if (!q.data.length) return null
  return (
    <section className="side-card">
      <h3 className="side-card__title">{title}</h3>
      {q.data.map(u => <UserRow key={u.handle} user={u} reason={u.reason} />)}
      <Link to="/search?type=people" className="side-card__more small">see more people</Link>
    </section>
  )
}

/** Creators with the most liked drops in the last two weeks (real activity, from /api/creators). */
export function Creators({ limit = 5, title = 'creators posting now' }: { limit?: number; title?: string }) {
  const { me } = useSession()
  const q = useQuery({ queryKey: ['creators', limit, me?.handle], queryFn: async () => {
    const r = await api<{ users: (ApiUser & { drops: number; likesRecent: number })[] }>(`/creators?limit=${limit}`)
    r.users.forEach(adoptUser); return r.users
  } })
  if (!q.data?.length) return null
  return (
    <section className="side-card">
      <h3 className="side-card__title">{title}</h3>
      {q.data.map(u => <UserRow key={u.handle} user={u} reason={`${compact(u.drops)} ${u.drops === 1 ? 'drop' : 'drops'} lately`} />)}
      <Link to="/search?type=people" className="side-card__more small">see more people</Link>
    </section>
  )
}

export function Trending({ limit = 5 }: { limit?: number }) {
  const q = useQuery({ queryKey: ['trending', limit], queryFn: () => api<{ tags: { tag: string; drops: number; people: number }[] }>(`/trending?limit=${limit}`), refetchInterval: 120_000 })
  if (!q.data && q.isError) return null
  if (!q.data) return (
    <section className="side-card" aria-busy="true" aria-label="trending tags, loading">
      <h3 className="side-card__title">trending tags</h3>
      <ol className="trend" aria-hidden="true">
        {Array.from({ length: limit }, (_, i) => (
          <li key={i}><span className="trend__row">
            <span className="trend__n num">{'\u00a0'}</span>
            <span className="trend__main"><span className="strong ph" style={{ width: `${38 + ((i * 13) % 30)}%` }}>{'\u00a0'}</span><span className="muted small ph" style={{ width: `${52 + ((i * 7) % 20)}%` }}>{'\u00a0'}</span></span>
          </span></li>
        ))}
      </ol>
    </section>
  )
  if (!q.data.tags.length) return null
  return (
    <section className="side-card">
      <h3 className="side-card__title">trending tags</h3>
      <ol className="trend">
        {q.data.tags.map((t, i) => (
          <li key={t.tag}><Link to={`/search?q=${encodeURIComponent('#' + t.tag)}`} className="trend__row">
            <span className="trend__n num">{i + 1}</span>
            <span className="trend__main"><span className="strong">#{t.tag}</span><span className="muted small">{compact(t.drops)} drops · {t.people} people</span></span>
          </Link></li>
        ))}
      </ol>
    </section>
  )
}

/** Calls onMore when the sentinel scrolls near the viewport. */
export function Sentinel({ onMore, active, done }: { onMore: () => void; active: boolean; done?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const cb = useRef(onMore); cb.current = onMore
  useEffect(() => {
    const el = ref.current
    if (!el || !active) return
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) cb.current() }, { rootMargin: '800px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [active])
  return <div ref={ref} className="sentinel">{active ? <span className="spinner" aria-label="loading more" /> : done}</div>
}

export function NewPill({ count, avatars, onClick }: { count: number; avatars: string[]; onClick: () => void }) {
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.button className="new-pill" onClick={onClick} initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
          transition={{ type: 'spring', stiffness: 500, damping: 34 }}>
          <Icon name="arrowUp" size={14} />
          {avatars.slice(0, 3).map(h => <Avatar key={h} handle={h} size={20} />)}
          <span>{count} new {count === 1 ? 'drop' : 'drops'}</span>
        </motion.button>
      )}
    </AnimatePresence>
  )
}
