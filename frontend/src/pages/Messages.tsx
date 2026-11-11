/**
 * Direct messages: an inbox (with a requests tab for people you don't follow) and one thread per pair.
 * Phone: one pane at a time. Desktop: the list on the left, the open chat on the right.
 * Text renders as React text nodes only (RichText makes the links), images come from the upload pipeline.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { useSession } from '../api/session'
import { api, ApiError } from '../api/client'
import {
  DM_CHARS, DM_IMAGE_MAX, DM_IMAGE_TYPES, addMessage, dropMessage, editThread, fetchInbox, fetchThread, inboxKey, threadKey,
  uploadDmImage, useDmLiveOn, useTyping, type DmInboxItem, type DmMessage, type DmThread,
} from '../api/dms'
import { useStore } from '../state/store'
import { at } from '../lib/format'
import { profilePath } from '../lib/paths'
import { Avatar } from '../components/Bits'
import { PlusMark, TipJar } from '../components/BrandSlots'
import { GuestWall } from '../components/GuestWall'
import { Icon } from '../components/Icon'
import { Mascot } from '../components/Mascot'
import { PageHead } from '../components/Shell'
import { RichText, useNeedLink } from '../components/Social'
import { Sheet } from '../sheets/Sheets'
import { userError } from '../lib/txError'

const GUEST_LINE = 'message people on wifly. sign up to send one.'

export function Inbox() { return <Messages /> }
export function Thread() { const { handle = '' } = useParams(); return <Messages handle={handle} /> }

function Messages({ handle }: { handle?: string }) {
  const { me, ready, guest } = useSession()
  if (ready && !me) return <><PageHead title="messages" back={!!handle} /><GuestWall line={GUEST_LINE} /></>
  if (!me) return <><PageHead title="messages" /><div className="dmx-skel" aria-busy="true" /></>
  if (guest || me.needsHandle) return <><PageHead title="messages" back={!!handle} /><LinkFirst needsHandle={!!me.needsHandle} /></>
  return (
    <div className={`dmx${handle ? ' dmx--open' : ''}`} data-testid="dm-page">
      <aside className="dmx__list" aria-label="conversations"><InboxPane active={handle} /></aside>
      <section className="dmx__chat" aria-label="chat">
        {handle ? <ThreadPane key={handle.toLowerCase()} handle={handle} /> : <div className="dmx__pick"><Mascot size={56} mood="calm" /><p className="strong">pick a conversation</p><p className="muted small">or start one from someone’s profile.</p></div>}
      </section>
    </div>
  )
}

function LinkFirst({ needsHandle }: { needsHandle: boolean }) {
  const need = useNeedLink()
  return (
    <div className="empty empty--card" data-testid="dm-linkfirst">
      <Mascot size={64} />
      <p className="strong">{needsHandle ? 'pick your @name to message people' : 'link an account to message people'}</p>
      <p className="muted small">messages need a wallet, x or email on your account, so people know who they’re talking to.</p>
      <button className="btn btn--dark btn--sm" onClick={() => need(() => {}, 'sign in to message')}>{needsHandle ? 'pick your @name' : 'link an account'}</button>
    </div>
  )
}

/* ---------- inbox ---------- */

function useInbox(tab: 'inbox' | 'requests') {
  const live = useDmLiveOn()
  return useInfiniteQuery({
    queryKey: inboxKey(tab), initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchInbox(tab, pageParam), getNextPageParam: l => l.next,
    refetchInterval: live ? 60_000 : 12_000,
  })
}

function InboxPane({ active }: { active?: string }) {
  const [tab, setTab] = useState<'inbox' | 'requests'>('inbox')
  const q = useInbox(tab)
  const other = useInbox(tab === 'inbox' ? 'requests' : 'inbox')
  const unread = q.data?.pages[0]?.unread ?? other.data?.pages[0]?.unread
  const items = q.data?.pages.flatMap(p => p.items) ?? []
  const [composing, setComposing] = useState(false)
  return (
    <>
      <header className="dmx__head">
        <h1 className="dmx__title">messages</h1>
        <button className="icon-btn dmx__new" aria-label="new message" title="new message" onClick={() => setComposing(true)}><Icon name="plus" size={18} /></button>
      </header>
      <div className="dmx__tabs" role="tablist">
        {(['inbox', 'requests'] as const).map(t => (
          <button key={t} role="tab" aria-selected={tab === t} className={`dmx__tab${tab === t ? ' is-on' : ''}`} data-testid={`dm-tab-${t}`} onClick={() => setTab(t)}>
            {t}{!!unread?.[t] && <span className="dmx__count num">{unread[t]}</span>}
          </button>
        ))}
      </div>
      {q.isLoading ? <ul className="dmx__rows">{[0, 1, 2].map(i => <li key={i} className="dmx__row dmx__row--skel"><span className="skel skel--av" /><span className="skel skel--l1" /></li>)}</ul>
        : !items.length ? (
          <div className="dmx__empty">
            <p className="strong">{tab === 'inbox' ? 'no messages yet' : 'no requests'}</p>
            <p className="muted small">{tab === 'inbox' ? 'start a chat from someone’s profile, or find people to follow.' : 'messages from people you don’t follow land here first. they won’t know you’ve seen them until you reply.'}</p>
            {tab === 'inbox' && <Link to="/search?type=people" className="btn btn--ghost btn--sm">find people</Link>}
          </div>
        ) : (
          <ul className="dmx__rows" data-testid={`dm-list-${tab}`}>
            {items.map(i => <InboxRow key={i.peer.handle} i={i} active={!!active && active.toLowerCase() === i.peer.handle.toLowerCase()} />)}
            {q.hasNextPage && <li><button className="btn btn--text btn--block" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? 'loading…' : 'show more'}</button></li>}
          </ul>
        )}
      <AnimatePresence>{composing && <NewMessageSheet onClose={() => setComposing(false)} />}</AnimatePresence>
    </>
  )
}

function preview(m: DmMessage | null) {
  if (!m) return ''
  const who = m.mine ? 'you: ' : ''
  if (m.kind === 'tip') return `${who}tipped ${fmtWif(m.tip?.amount ?? 0)} wif`
  if (!m.text && m.image) return `${who}sent a photo`
  return who + m.text.replace(/\s+/g, ' ')
}

function InboxRow({ i, active }: { i: DmInboxItem; active: boolean }) {
  const p = i.peer
  return (
    <li>
      <Link to={`/messages/${p.handle}`} className={`dmx__row${active ? ' is-active' : ''}${i.unread ? ' is-unread' : ''}`} data-testid="dm-row" aria-current={active ? 'page' : undefined}>
        <Avatar handle={p.handle} size={44} />
        <span className="dmx__rowtext">
          <span className="dmx__rowtop">
            <b className="clamp-1">{p.wifName ? `${p.wifName}.wif` : p.name}</b>{p.plus && <PlusMark size={13} />}
            <span className="dmx__at clamp-1">{at(p.handle)}</span>
            <span className="dmx__time">{shortTime(i.at)}</span>
          </span>
          <span className="dmx__preview clamp-1">{preview(i.last)}</span>
        </span>
        {i.unread > 0 && <span className="dmx__dot num" aria-label={`${i.unread} unread`}>{i.unread > 9 ? '9+' : i.unread}</span>}
      </Link>
    </li>
  )
}

function NewMessageSheet({ onClose }: { onClose: () => void }) {
  const nav = useNavigate()
  const [v, setV] = useState('')
  const h = v.trim().replace(/^@/, '').replace(/\.wif$/i, '')
  const go = (e: FormEvent) => { e.preventDefault(); if (h) { onClose(); nav(`/messages/${h}`) } }
  return (
    <Sheet title="new message" onClose={onClose} size="sm">
      <form onSubmit={go} className="dmx__newform">
        <label className="field"><span className="field__label">to</span>
          <span className="field__input"><input autoFocus value={v} onChange={e => setV(e.target.value)} placeholder="@name" autoCapitalize="none" spellCheck={false} aria-label="who to message" /></span>
        </label>
        <button className="btn btn--dark btn--block" disabled={!h}>open chat</button>
        <Link to="/search?type=people" className="btn btn--text btn--block" onClick={onClose}>find people</Link>
      </form>
    </Sheet>
  )
}

/* ---------- thread ---------- */

function useThread(handle: string) {
  const live = useDmLiveOn()
  return useInfiniteQuery({
    queryKey: threadKey(handle), initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchThread(handle, pageParam), getNextPageParam: l => l.next,
    refetchInterval: live ? 90_000 : 6_000, retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  })
}

function ThreadPane({ handle }: { handle: string }) {
  const q = useThread(handle)
  const qc = useQueryClient()
  const { toast, openSheet } = useStore()
  const nav = useNavigate()
  const first = q.data?.pages[0]
  const msgs = useMemo(() => q.data ? [...q.data.pages].reverse().flatMap(p => p.items) : [], [q.data])
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [menu, setMenu] = useState(false)
  const [reporting, setReporting] = useState<{ messageId?: number } | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const typing = useTyping(handle)
  const peer = first?.peer

  // stick to the bottom for new messages unless you scrolled up to read
  const lastId = msgs[msgs.length - 1]?.id
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return
    if (pinned.current) el.scrollTop = el.scrollHeight
  }, [lastId, typing])
  const onScroll = () => {
    const el = scroller.current; if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 60 && q.hasNextPage && !q.isFetchingNextPage) {
      const h = el.scrollHeight
      q.fetchNextPage().then(() => requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight - h + el.scrollTop }))
    }
  }

  // reading the thread clears its unread count (quietly: no receipt while it's still a request)
  const theirLast = [...msgs].reverse().find(m => !m.mine && m.id > 0)?.id ?? 0
  const myRead = first?.myRead ?? 0
  useEffect(() => {
    if (!theirLast || theirLast <= myRead || document.visibilityState === 'hidden') return
    api<{ upTo: number }>(`/dms/${handle}/read`, { method: 'POST' }).then(r => {
      editThread(qc, handle, (f, d) => ({ ...d, pages: [{ ...f, myRead: r.upTo }, ...d.pages.slice(1)] }))
      qc.invalidateQueries({ queryKey: ['dms', 'list'] }); qc.invalidateQueries({ queryKey: ['me'] })
    }).catch(() => {})
  }, [theirLast, myRead, handle, qc])

  if (q.isError) {
    const gone = q.error instanceof ApiError && q.error.status === 404
    return <div className="dmx__pick"><Mascot size={56} mood="oops" /><p className="strong">{gone ? 'no one here by that name.' : 'couldn’t open this chat'}</p><p className="muted small">{gone ? 'maybe a typo, or they changed their name.' : 'check your connection, then try again.'}</p><Link to="/messages" className="btn btn--ghost btn--sm">back to messages</Link></div>
  }
  if (!first || !peer) return <div className="dmx__pick" aria-busy="true"><span className="skel skel--av" /></div>

  const block = async (on: boolean) => {
    try {
      await api(`/users/${peer.handle}/block`, { method: on ? 'POST' : 'DELETE' })
      qc.invalidateQueries({ queryKey: ['dms'] }); qc.invalidateQueries({ queryKey: ['me'] }); qc.invalidateQueries({ queryKey: ['user', peer.handle] })
      toast(on ? `blocked ${at(peer.handle)}. neither of you will see this chat.` : `unblocked ${at(peer.handle)}`)
    } catch (e) { toast('that didn’t go through', userError(e)) }
  }
  const accept = async () => {
    try { await api(`/dms/${peer.handle}/accept`, { method: 'POST' }); qc.invalidateQueries({ queryKey: ['dms'] }); qc.invalidateQueries({ queryKey: ['me'] }) }
    catch (e) { toast('that didn’t go through', userError(e)) }
  }
  const remove = async (m: DmMessage) => {
    setPicked(null)
    dropMessage(qc, peer.handle, m.id)
    try { await api(`/dms/messages/${m.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['dms', 'list'] }) }
    catch (e) { toast('that didn’t go through', userError(e)); qc.invalidateQueries({ queryKey: threadKey(peer.handle) }) }
  }
  const lastMine = [...msgs].reverse().find(m => m.mine && m.id > 0)
  const seen = !!lastMine && first.peerRead >= lastMine.id && !first.pending
  const name = peer.wifName ? `${peer.wifName}.wif` : peer.name

  return (
    <div className="dmt" data-testid="dm-thread">
      <header className="dmt__head">
        <button className="dmt__back" aria-label="back to messages" onClick={() => nav('/messages')}><Icon name="back" size={18} /></button>
        <Link to={profilePath(peer.handle)} className="dmt__who">
          <Avatar handle={peer.handle} size={36} />
          <span className="dmt__names"><b className="clamp-1">{name}{peer.plus && <PlusMark size={13} />}</b><span className="dmt__sub clamp-1">{typing ? <span className="dmt__typing">typing…</span> : at(peer.handle)}</span></span>
        </Link>
        {first.canMessage && <button className="icon-btn" aria-label={`tip ${at(peer.handle)}`} title="tip" data-testid="dm-tip" onClick={() => openSheet({ type: 'tip', to: peer.handle, dm: true })}><TipJar size={17} title="" /></button>}
        <div className="dmt__menu">
          <button className="icon-btn" aria-label="chat options" aria-haspopup="menu" aria-expanded={menu} data-testid="dm-menu" onClick={() => setMenu(o => !o)}><Icon name="more" size={18} /></button>
          {menu && <>
            <div className="dmt__scrim" onClick={() => setMenu(false)} />
            <div className="dmenu__pop" role="menu">
              <button role="menuitem" onClick={() => { setMenu(false); nav(profilePath(peer.handle)) }}><Icon name="user" size={16} /> view profile</button>
              <button role="menuitem" onClick={() => { setMenu(false); setReporting({}) }}><Icon name="shield" size={16} /> report</button>
              <button role="menuitem" className={first.blocked === 'you' ? '' : 'is-danger'} data-testid="dm-block" onClick={() => { setMenu(false); void block(first.blocked !== 'you') }}><Icon name="lock" size={16} /> {first.blocked === 'you' ? 'unblock' : 'block'} {at(peer.handle)}</button>
            </div>
          </>}
        </div>
      </header>

      <div className="dmt__scroll" ref={scroller} onScroll={onScroll} data-testid="dm-scroll">
        {q.hasNextPage ? <div className="dmt__more">{q.isFetchingNextPage ? 'loading…' : <button className="btn btn--text btn--sm" onClick={() => q.fetchNextPage()}>earlier messages</button>}</div>
          : <div className="dmt__intro">
              <Avatar handle={peer.handle} size={64} />
              <b>{name}</b>
              <span className="muted small">{at(peer.handle)} · {peer.followers.toLocaleString()} {peer.followers === 1 ? 'follower' : 'followers'}{peer.followsYou ? ' · follows you' : ''}</span>
              <Link to={profilePath(peer.handle)} className="btn btn--ghost btn--sm">view profile</Link>
            </div>}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1]
          const day = !prev || dayKey(prev.at) !== dayKey(m.at)
          const tail = !msgs[i + 1] || msgs[i + 1]!.mine !== m.mine || msgs[i + 1]!.at - m.at > 5 * 60_000
          return (
            <Fragment key={m.id}>
              {day && <div className="dmt__day">{dayLabel(m.at)}</div>}
              <Bubble m={m} tail={tail} picked={picked === m.id} onPick={() => setPicked(p => p === m.id ? null : m.id)}
                onDelete={() => remove(m)} onReport={() => { setPicked(null); setReporting({ messageId: m.id }) }} />
              {m === lastMine && <div className="dmt__receipt" data-testid="dm-receipt">{seen ? 'seen' : 'sent'}</div>}
            </Fragment>
          )
        })}
        {typing && <div className="dmt__dots" aria-label="typing"><span /><span /><span /></div>}
      </div>

      {first.blocked === 'you' ? (
        <div className="dmt__notice" data-testid="dm-blocked"><p>you blocked {at(peer.handle)}. they can’t message you and this chat is hidden for both of you.</p><button className="btn btn--ghost btn--sm" onClick={() => block(false)}>unblock</button></div>
      ) : first.blocked === 'them' ? (
        <div className="dmt__notice"><p>you can’t message {at(peer.handle)}.</p></div>
      ) : !first.canMessage ? (
        <div className="dmt__notice"><p>{at(peer.handle)} can’t get messages yet.</p></div>
      ) : <>
        {first.request && (
          <div className="dmt__request" data-testid="dm-request">
            <p><b>{name}</b> wants to message you. they won’t know you’ve seen this until you reply or accept.</p>
            <div className="dmt__request-acts">
              <button className="btn btn--dark btn--sm" data-testid="dm-accept" onClick={accept}>accept</button>
              <button className="btn btn--ghost btn--sm" onClick={() => block(true)}>block</button>
              <button className="btn btn--text btn--sm" onClick={() => setReporting({})}>report</button>
            </div>
          </div>
        )}
        {first.pending && msgs.some(m => m.mine) && <p className="dmt__pending">this is a request until {at(peer.handle)} replies. you can send a few messages until then.</p>}
        <Composer handle={peer.handle} onSent={() => { pinned.current = true }} />
      </>}
      <AnimatePresence>{reporting && <ReportSheet handle={peer.handle} messageId={reporting.messageId} onClose={() => setReporting(null)} />}</AnimatePresence>
    </div>
  )
}

function Bubble({ m, tail, picked, onPick, onDelete, onReport }: { m: DmMessage; tail: boolean; picked: boolean; onPick: () => void; onDelete: () => void; onReport: () => void }) {
  const cls = `dmb${m.mine ? ' dmb--me' : ''}${tail ? ' dmb--tail' : ''}${m.pending ? ' is-pending' : ''}${m.kind === 'tip' ? ' dmb--tip' : ''}`
  return (
    <div className={`dmb-row${m.mine ? ' dmb-row--me' : ''}`}>
      <div className={cls} data-testid={m.kind === 'tip' ? 'dm-tip-bubble' : 'dm-bubble'} onClick={e => { if (!(e.target as HTMLElement).closest('a')) onPick() }}>
        {m.kind === 'tip' ? (
          <span className="dmb__tip"><TipJar size={20} title="" /><span><b className="num">{fmtWif(m.tip?.amount ?? 0)} wif</b><span className="dmb__tipline">{m.mine ? 'tip sent' : 'tip received'}{m.tip?.verified ? ' · onchain' : ''}</span></span></span>
        ) : <>
          {m.image && <a href={m.image} target="_blank" rel="noopener noreferrer" className="dmb__img"><img src={m.image} alt="photo" loading="lazy" /></a>}
          {m.text && <RichText text={m.text} className="dmb__text" />}
        </>}
      </div>
      <AnimatePresence>{picked && !m.pending && (
        <motion.div className="dmb__acts" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
          <span className="dmb__at">{clock(m.at)}</span>
          {m.mine ? <button type="button" onClick={onDelete} data-testid="dm-delete">delete for you</button> : <button type="button" onClick={onReport}>report</button>}
        </motion.div>
      )}</AnimatePresence>
    </div>
  )
}

const EMOJI = ['😀', '😂', '🥹', '😍', '🙏', '👍', '🔥', '🎉', '💛', '👀', '🌍', '🚀', '💯', '😅', '🤝', '✨']

function Composer({ handle, onSent }: { handle: string; onSent: () => void }) {
  const qc = useQueryClient()
  const { toast } = useStore()
  const [text, setText] = useState('')
  const [img, setImg] = useState<{ url: string | null; local: string; busy: boolean } | null>(null)
  const [emoji, setEmoji] = useState(false)
  const [sending, setSending] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const lastTyping = useRef(0)
  const len = [...text].length
  const over = len > DM_CHARS
  const can = !sending && !over && !img?.busy && (!!text.trim() || !!img?.url)

  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px` } }, [text])
  useEffect(() => () => { if (img?.local) URL.revokeObjectURL(img.local) }, [img?.local])

  const onType = (v: string) => {
    setText(v)
    if (v && Date.now() - lastTyping.current > 4000) { lastTyping.current = Date.now(); api(`/dms/${handle}/typing`, { method: 'POST' }).catch(() => {}) }
  }
  const pick = async (f: File | undefined) => {
    if (!f) return
    if (!DM_IMAGE_TYPES.includes(f.type)) { toast('use a png, jpg, webp or gif'); return }
    if (f.size > DM_IMAGE_MAX) { toast('images up to 20 mb'); return }
    const local = URL.createObjectURL(f)
    setImg({ url: null, local, busy: true })
    try { const url = await uploadDmImage(f); setImg(s => s && s.local === local ? { ...s, url, busy: false } : s) }
    catch (e) { setImg(null); toast('that photo didn’t upload', userError(e)) }
  }
  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!can) return
    const body = { text: text.trim(), image: img?.url ?? null }
    const temp = -Date.now()
    addMessage(qc, handle, { id: temp, mine: true, kind: 'text', text: body.text, image: img?.local ?? null, tip: null, at: Date.now(), pending: true })
    const keep = { text, img }
    setText(''); setImg(null); setEmoji(false); setSending(true); onSent()
    try {
      const r = await api<{ message: DmMessage }>(`/dms/${handle}`, { method: 'POST', json: body })
      addMessage(qc, handle, r.message, temp)
      qc.invalidateQueries({ queryKey: ['dms', 'list'] })
      editThread(qc, handle, (f, d) => f.request ? { ...d, pages: [{ ...f, request: false }, ...d.pages.slice(1)] } : d)
    } catch (err) {
      dropMessage(qc, handle, temp)
      setText(keep.text); setImg(keep.img)
      toast('message not sent', (err as Error).message)
    } finally { setSending(false); ta.current?.focus() }
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(hover: hover)').matches) { e.preventDefault(); void send() }
  }
  return (
    <form className="dmc" onSubmit={send} data-testid="dm-composer">
      {img && <div className="dmc__img"><img src={img.local} alt="" />{img.busy && <span className="dmc__up">uploading…</span>}<button type="button" aria-label="remove photo" onClick={() => setImg(null)}><Icon name="close" size={14} /></button></div>}
      {emoji && <div className="dmc__emoji" role="listbox" aria-label="emoji">{EMOJI.map(x => <button type="button" key={x} onClick={() => { onType(text + x); ta.current?.focus() }}>{x}</button>)}</div>}
      <div className="dmc__bar">
        <button type="button" className="dmc__tool" aria-label="add a photo" onClick={() => file.current?.click()}><Icon name="image" size={19} /></button>
        <input ref={file} type="file" accept={DM_IMAGE_TYPES.join(',')} hidden data-testid="dm-file" onChange={e => { void pick(e.target.files?.[0]); e.target.value = '' }} />
        <button type="button" className={`dmc__tool${emoji ? ' is-on' : ''}`} aria-label="emoji" aria-expanded={emoji} onClick={() => setEmoji(o => !o)}><span aria-hidden="true">☺</span></button>
        <textarea ref={ta} rows={1} value={text} onChange={e => onType(e.target.value)} onKeyDown={onKey} placeholder="message" aria-label="message" maxLength={DM_CHARS * 2} data-testid="dm-input" />
        <button className="dmc__send" disabled={!can} aria-label="send" data-testid="dm-send"><Icon name="send" size={17} /></button>
      </div>
      {len > DM_CHARS - 200 && <span className={`dmc__left${over ? ' is-over' : ''}`}>{DM_CHARS - len}</span>}
    </form>
  )
}

function ReportSheet({ handle, messageId, onClose }: { handle: string; messageId?: number; onClose: () => void }) {
  const { toast } = useStore()
  const [reason, setReason] = useState<'spam' | 'abuse' | 'scam' | 'other'>('spam')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try { await api(`/dms/${handle}/report`, { method: 'POST', json: { reason, note, messageId } }); toast('thanks. we’ll take a look.'); onClose() }
    catch (e) { toast('that didn’t go through', userError(e)) } finally { setBusy(false) }
  }
  return (
    <Sheet title={messageId ? 'report this message' : `report ${at(handle)}`} onClose={onClose} size="sm"
      footer={<button className="btn btn--dark btn--block" disabled={busy} onClick={go} data-testid="dm-report-send">{busy ? 'sending…' : 'send report'}</button>}>
      <div className="dmx__reasons" role="radiogroup">
        {(['spam', 'abuse', 'scam', 'other'] as const).map(r => (
          <button key={r} type="button" role="radio" aria-checked={reason === r} className={`dmx__reason${reason === r ? ' is-on' : ''}`} onClick={() => setReason(r)}>{r}</button>
        ))}
      </div>
      <label className="field"><span className="field__label">anything else (optional)</span>
        <span className="field__input"><input value={note} maxLength={500} onChange={e => setNote(e.target.value)} placeholder="what happened" /></span>
      </label>
      <p className="muted small">they won’t know you reported them. you can also block them from the chat menu.</p>
    </Sheet>
  )
}

/* ---------- small formatters ---------- */
function fmtWif(n: number) { return n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 }) }
const dayKey = (t: number) => new Date(t).toDateString()
function dayLabel(t: number) {
  const d = new Date(t), now = new Date()
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return 'today'
  if (d.toDateString() === y.toDateString()) return 'yesterday'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).toLowerCase()
}
const clock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
function shortTime(t: number) {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()
}
export type { DmThread }
