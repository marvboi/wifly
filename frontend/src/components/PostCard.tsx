import { postPath, profilePath } from '../lib/paths'
import { AnimatePresence, motion } from 'motion/react'
import { softSpring, spring } from './Motion'
import { Tick } from './Delight'
import { PlusMark, TipJar } from './BrandSlots'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { shareLink, shareToast } from '../lib/share'
import { Link, useNavigate } from 'react-router-dom'
import type { Post } from '../state/registry'
import { useStore } from '../state/store'
import { compact } from '../lib/format'
import { Amount, Avatar, DisplayName, FlatDisc, Sparkline, Token } from './Bits'
import { Icon } from './Icon'
import { useQueryClient } from '@tanstack/react-query'
import { api, deleteDrop, toggleDrop } from '../api/client'
import { useLive, useSession, useUser } from '../api/session'
import { DropImage, QuoteEmbed, RichText, useGate, useNeedLink } from './Social'

export function PostMedia({ post }: { post: Post }) {
  const m = post.media
  if (!m) return null
  if (m.kind === 'chart') {
    return (
      <div className="media media--chart">
        <div className="media__chart-head">
          <span className="strong">{m.label}</span>
          <span className="chg"><Icon name="arrowUp" size={14} /> {m.change.toFixed(2)}%</span>
        </div>
        <Sparkline points={m.points} />
      </div>
    )
  }
  if (m.kind === 'map') {
    return (
      <div className="media media--map">
        <FlatDisc />
        <span className="media__caption">{m.caption}</span>
      </div>
    )
  }
  return (
    <div className="media media--file">
      <span className="media__file-icon"><Icon name="file" size={20} /></span>
      <div><div className="strong small">{m.name}</div><div className="muted small">{m.size}</div></div>
    </div>
  )
}

export function PostBody({ post }: { post: Post }) {
  const { unlocked, subs, openSheet } = useStore()
  if (post.locked && !unlocked.has(post.id)) {
    return (
      <>
        <RichText text={post.text} />
        <div className="locked">
          <div className="locked__veil" aria-hidden="true"><FlatDisc /></div>
          <div className="locked__body">
            <span className="locked__icon"><Icon name="lock" size={18} /></span>
            <div className="locked__teaser">{post.locked.teaser}</div>
            <button className="btn btn--dark" onClick={e => { e.stopPropagation(); openSheet({ type: 'unlock', postId: post.id }) }}>
              unlock for <Amount value={post.locked.price} size={16} />
            </button>
            <div className="muted small">{post.locked.unlocks.toLocaleString()} unlocked</div>
          </div>
        </div>
      </>
    )
  }
  if (post.supportersOnly && !subs[post.author]) {
    return (
      <div className="locked locked--subs">
        <div className="locked__body">
          <span className="locked__icon"><Icon name="star" size={18} /></span>
          <div className="locked__teaser">for {post.supportersOnly} supporters</div>
          <button className="btn btn--dark" onClick={e => { e.stopPropagation(); openSheet({ type: 'subscribe', handle: post.author }) }}>see tiers</button>
        </div>
      </div>
    )
  }
  return (
    <>
      {post.supportersOnly && <div className="tagline"><Icon name="star" size={12} fill /> {post.supportersOnly} · supporters only</div>}
      {post.text && <RichText text={post.text} />}
      {post.image && <DropImage src={post.image} />}
      {(post.quote || post.quoteMissing) && <QuoteEmbed post={post.quote} missing={post.quoteMissing} />}
      {post.locked && <div className="tagline"><Icon name="unlock" size={12} /> unlocked</div>}
      <PostMedia post={post} />
    </>
  )
}

const ago = (t: string) => {
  const m = /^(\d+)([mhd])$/.exec(t)
  if (!m) return t.toLowerCase()
  return `${m[1]}${m[2]}`
}

/**
 * A small menu in a portal on <body>: never clipped by a card or covered by the dock. It sits under its button and flips
 * above it when there isn't room below (the last post on a phone). Closes on outside tap, Escape, scroll or resize.
 */
function Pop({ open, onClose, anchor, children, align = 'right' }: { open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; children: ReactNode; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null)
  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect(), m = ref.current
    if (!a || !m) return
    const w = m.offsetWidth, h = m.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, gap = 6, pad = 8
    // keep clear of the phone dock when it's showing
    const dock = document.querySelector('.dock')?.getBoundingClientRect()
    const bottom = dock && dock.height && dock.top < vh ? dock.top : vh
    const up = a.bottom + gap + h > bottom - pad && a.top - gap - h >= pad
    const left = Math.min(Math.max(pad, align === 'right' ? a.right - w : a.left), vw - w - pad)
    setPos({ top: up ? a.top - gap - h : a.bottom + gap, left, up })
  }, [anchor, align])
  useLayoutEffect(() => { if (open) place(); else setPos(null) }, [open, place])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { const t = e.target as Node; if (!ref.current?.contains(t) && !anchor.current?.contains(t)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onClose(); anchor.current?.querySelector('button')?.focus() } }
    const onMove = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    document.addEventListener('pointerdown', onDown, true); document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onMove, true); window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onMove, true); window.removeEventListener('resize', onClose)
    }
  }, [open, onClose, anchor])
  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>{open && (
      <motion.div ref={ref} className={`dmenu__pop dmenu__pop--float ${pos?.up ? 'is-up' : ''}`} role="menu" onClick={e => e.stopPropagation()}
        style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
        initial={{ opacity: 0, y: pos?.up ? 6 : -6 }} animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: { duration: 0.12 } }} transition={{ type: 'spring', stiffness: 500, damping: 32 }}>
        {children}
      </motion.div>
    )}</AnimatePresence>, document.body)
}

const postUrl = (post: Post) => `${location.origin}${postPath(post.id, post.author)}`

/** Overflow: copy link, not interested, mute, delete your own. */
function DropMenu({ post }: { post: Post }) {
  const { toast } = useStore()
  const qc = useQueryClient()
  const gate = useGate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const pick = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); setOpen(false); fn() }
  const fail = (e: Error) => toast('that didn’t go through', e.message)
  const server = !!post.server
  return (
    <div className="dmenu" ref={ref} onClick={e => e.stopPropagation()}>
      <button className="act act--icon" aria-label="more" aria-expanded={open} onClick={() => setOpen(o => !o)}><Icon name="more" size={18} /></button>
      <Pop open={open} onClose={close} anchor={ref}>
        <button role="menuitem" onClick={pick(() => { shareLink(postUrl(post), undefined, { writeText: s => navigator.clipboard.writeText(s) }).then(r => { const t = shareToast(r); if (t) toast(t) }) })}><Icon name="link" size={16} /> copy link</button>
        {server && !post.mine && <button role="menuitem" onClick={pick(() => {
          if (!gate('sign in to tune your feed')) return
          api(`/drops/${post.id}/not-interested`, { method: 'POST' }).then(() => { toast('got it. less like this'); qc.invalidateQueries({ queryKey: ['feed', 'foryou'] }) }).catch(fail)
        })}><Icon name="eyeOff" size={16} /> not interested</button>}
        {server && !post.mine && <button role="menuitem" onClick={pick(() => {
          if (!gate('sign in to mute people')) return
          api(`/users/${post.author}/mute`, { method: 'POST' }).then(() => { toast(`muted @${post.author}`); qc.invalidateQueries({ queryKey: ['feed'] }) }).catch(fail)
        })}><Icon name="mute" size={16} /> mute @{post.author}</button>}
        {server && post.mine && <button role="menuitem" className="is-danger" onClick={pick(() => {
          if (!confirm('delete this drop? this can’t be undone.')) return
          deleteDrop(post.id).then(() => { toast('drop deleted'); qc.invalidateQueries({ queryKey: ['feed'] }) }).catch(fail)
        })}><Icon name="trash" size={16} /> delete</button>}
      </Pop>
    </div>
  )
}

/** Totals as small badges: what the drop has earned and how the crowd voted. */
export function DropTotals({ post }: { post: Post }) {
  const { votes } = useStore()
  const myVotes = votes[`post:${post.id}`] ?? 0
  return (
    <div className="totals">
      <span className="total total--tip" title="WIF tipped"><Token size={14} /> <Tick value={post.tipped} /></span>
      <span className={`total ${myVotes ? 'is-on' : ''}`} title="votes"><Icon name="vote" size={13} fill={!!myVotes} /> <Tick value={post.votes + myVotes} /></span>
    </div>
  )
}

function Count({ n }: { n: number }) {
  return <span className="act__n num">{n > 0 ? compact(n) : ''}</span>
}

/**
 * The action bar: reply, pass it on (or quote), like, bookmark, share on the left;
 * the $WIF chips (tip, vote) and the overflow on the right. Signed-out taps open sign-in.
 */
export function PostActions({ post: p0 }: { post: Post; big?: boolean }) {
  const post = useLive(p0)
  const store = useStore()
  const { openSheet, votes, toast } = store
  const gate = useGate()
  const need = useNeedLink()
  const { me: viewer, guest } = useSession()
  const nav = useNavigate()
  const myVotes = votes[`post:${post.id}`] ?? 0
  const [pop, setPop] = useState(0)
  const server = !!post.server
  const mine = server ? !!post.mine : post.author === 'you'
  const liked = server ? !!post.liked : store.liked.has(post.id)
  const passed = server ? !!post.passed : store.reposted.has(post.id)
  const likes = server ? post.likes : post.likes + (liked ? 1 : 0)
  const passes = server ? post.reposts : post.reposts + (passed ? 1 : 0)
  const [passOpen, setPassOpen] = useState(false)
  const passRef = useRef<HTMLDivElement>(null)
  const closePass = useCallback(() => setPassOpen(false), [])
  const [burst, setBurst] = useState(0)
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); fn() }
  const fail = (e: Error) => toast('that didn’t go through', e.message)
  const toggle = (kind: 'like' | 'pass' | 'bookmark') => {
    if (!server) { if (kind === 'like') store.toggleLike(post.id); else if (kind === 'pass') store.toggleRepost(post.id); return }
    if (kind !== 'bookmark') { need(() => { toggleDrop(post.id, kind).catch(fail) }, kind === 'like' ? 'sign in to like drops' : 'sign in to pass drops on'); return }
    if (!gate('sign in to save drops')) return
    toggleDrop(post.id, kind).catch(fail)
    toast(post.bookmarked ? 'removed from bookmarks' : 'saved to bookmarks')
  }
  const share = async () => {
    const t = shareToast(await shareLink(postUrl(post), post.text.slice(0, 120)))
    if (t) toast(t)
  }
  return (
    <div className="drop__actions" onClick={e => e.stopPropagation()}>
      <div className="acts">
        <button className="act" aria-label={`reply, ${post.replies} replies`} onClick={stop(() => {
          if (server) need(() => openSheet({ type: 'compose', replyTo: post.id }), 'sign in to reply'); else nav(`/post/${post.id}`)
        })}><Icon name="reply" size={18} /><Count n={post.replies} /></button>

        <div className="dmenu" ref={passRef}>
          <button className={`act act--pass ${passed ? 'is-on' : ''}`} aria-label={`pass it on, ${passes}`} aria-expanded={passOpen}
            onClick={stop(() => (server ? setPassOpen(o => !o) : toggle('pass')))}>
            <Icon name="repost" size={18} /><Count n={passes} />
          </button>
          <Pop open={passOpen} onClose={closePass} anchor={passRef} align="left">
            <button role="menuitem" className={passed ? 'is-on' : ''} onClick={stop(() => { setPassOpen(false); toggle('pass') })}><Icon name="repost" size={16} /> {passed ? 'undo pass it on' : 'pass it on'}</button>
            <button role="menuitem" onClick={stop(() => { setPassOpen(false); need(() => openSheet({ type: 'compose', quoteOf: post.id }), 'sign in to quote drops') })}><Icon name="quote" size={16} /> quote</button>
          </Pop>
        </div>

        <button className={`act act--like ${liked ? 'is-on' : ''}`} aria-label={`${liked ? 'unlike' : 'like'}, ${likes}`} aria-pressed={liked}
          onClick={stop(() => { if (!liked && (!server || (viewer && !guest))) setBurst(b => b + 1); toggle('like') })}>
          <motion.span key={burst} className="act__icon" initial={burst ? { scale: 0.6 } : false} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 14 }}>
            <Icon name="heart" size={18} fill={liked} />
          </motion.span>
          <Count n={likes} />
        </button>

        {server && <button className={`act act--icon act--save ${post.bookmarked ? 'is-on' : ''}`} aria-label={post.bookmarked ? 'remove bookmark' : 'bookmark'} aria-pressed={!!post.bookmarked}
          onClick={stop(() => toggle('bookmark'))}><Icon name="bookmark" size={18} fill={!!post.bookmarked} /></button>}
        <button className="act act--icon act--share" aria-label="share" onClick={stop(share)}><Icon name="share" size={18} /></button>
      </div>
      <div className="acts acts--wif">
        {!mine && <motion.button whileTap={{ scale: 0.92 }} transition={spring} className="chip chip--tip" onClick={stop(() => { setPop(k => k + 1); openSheet({ type: 'tip', to: post.author, postId: post.id }) })}><TipJar size={15} title="" /> <span className="chip__label">tip</span>{pop > 0 && <img key={pop} className="chip__coin" src="/brand/wif-coin-256.png" alt="" aria-hidden="true" />}</motion.button>}
        <motion.button whileTap={{ scale: 0.92 }} transition={spring} className={`chip chip--vote ${myVotes ? 'is-on' : ''}`} onClick={stop(() => openSheet({ type: 'vote', handle: post.author, postId: post.id }))}>
          <Icon name="vote" size={15} fill={!!myVotes} /> <span className="chip__label">{myVotes ? `voted ${myVotes}` : 'vote'}</span>
        </motion.button>
        <DropMenu post={post} />
      </div>
    </div>
  )
}

function Byline({ post, big }: { post: Post; big?: boolean }) {
  const u = useUser(post.author)
  return (
    <Link to={profilePath(post.author)} onClick={e => e.stopPropagation()} className="drop__who">
      <Avatar handle={post.author} size={big ? 48 : 40} />
      <span className="drop__byline">
        <span className="drop__name"><span className="clamp-1">{u ? <DisplayName user={u} /> : post.author}</span>{u?.plus && <PlusMark size={14} />}</span>
        <span className="drop__when">@{post.author}{big ? '' : ` · ${ago(post.time)}`}</span>
      </span>
    </Link>
  )
}

/**
 * A drop: a paper card with the author over the handle and time, totals as badges, the text (with #tags,
 * @mentions and links), an image or quote, and the action bar.
 * variant: 'feed' (default), 'focal' (the drop a thread page is about) or 'thread' (a parent/reply with a connector line).
 */
/** Small "why am I seeing this" line under a For-you drop. Tap to reveal the one-line reason from the ranker. */
function WhyLine({ why }: { why: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="drop__why" onClick={e => e.stopPropagation()}>
      {open ? <span><Icon name="info" size={12} /> {why}</span>
        : <button type="button" className="drop__whybtn" onClick={() => setOpen(true)}>why am I seeing this?</button>}
    </div>
  )
}

export function PostCard({ post: p0, rank, passedBy, variant = 'feed', showReplyTo = true, line, why }: {
  post: Post; rank?: number; passedBy?: string; variant?: 'feed' | 'focal' | 'thread'; showReplyTo?: boolean; line?: boolean; why?: string
}) {
  const nav = useNavigate()
  const post = useLive(p0)
  const by = passedBy ?? post.repostedBy
  const byUser = useUser(by ?? '')
  const focal = variant === 'focal'
  if (post.deleted) return <article className="drop drop--gone muted small">this drop was deleted.</article>
  const open = () => { if (!focal) nav(postPath(post.id, post.author)) }
  return (
    <motion.article className={`drop drop--${variant} ${line ? 'drop--line' : ''}`} initial={focal ? false : { opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} whileHover={focal ? undefined : { y: -2 }}
      viewport={{ once: true, margin: '0px 0px -40px 0px' }} transition={softSpring} onClick={open} tabIndex={focal ? -1 : 0}
      onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) open() }}>
      {by && <div className="drop__context"><Icon name="repost" size={13} /> {byUser?.you ? 'you passed this on' : `passed on by ${byUser?.name ?? by}`}</div>}
      {showReplyTo && post.replyToHandle && variant !== 'thread' && <div className="drop__context">replying to <Link to={profilePath(post.replyToHandle)} className="rt-link" onClick={e => e.stopPropagation()}>@{post.replyToHandle}</Link></div>}
      <header className="drop__head">
        <Byline post={post} big={focal} />
        {rank !== undefined && <span className="drop__rank num" aria-label={`rank ${rank}`}>no. {String(rank).padStart(2, '0')}</span>}
        {(post.tipped > 0 || post.votes > 0 || !post.server) && <DropTotals post={post} />}
      </header>
      <div className={`drop__body ${focal ? 'drop__body--lg' : ''}`}><PostBody post={post} /></div>
      {focal && post.createdAt && (
        <div className="drop__stamp muted small">
          {new Date(post.createdAt).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short', year: 'numeric' }).toLowerCase()}
        </div>
      )}
      {focal && (post.likes + post.reposts + (post.quotes ?? 0)) > 0 && (
        <div className="drop__stats small">
          <span><b className="num">{compact(post.reposts)}</b> passed on</span>
          <span><b className="num">{compact(post.quotes ?? 0)}</b> quotes</span>
          <span><b className="num">{compact(post.likes)}</b> likes</span>
        </div>
      )}
      <PostActions post={post} />
      {why && variant === 'feed' && <WhyLine why={why} />}
    </motion.article>
  )
}
