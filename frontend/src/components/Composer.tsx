/** The composer: inline on home, in the "new drop" sheet, and as the reply box on a drop page. */
import { motion, AnimatePresence } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { adoptDrop, api, getDrop, setDrop, uploadImage, type ApiDrop, type Page } from '../api/client'
import { useSession } from '../api/session'
import { useStore } from '../state/store'
import type { Post } from '../state/registry'
import { users } from '../state/registry'
import { Avatar } from './Bits'
import { Icon } from './Icon'
import { QuoteEmbed } from './Social'

export const DROP_CHARS = 400
const count = (s: string) => [...s].length

/** A small ring that fills as you type and turns red past the limit. */
function Ring({ used, max }: { used: number; max: number }) {
  const r = 9, c = 2 * Math.PI * r
  const pct = Math.min(1, used / max)
  const left = max - used
  const tone = left < 0 ? 'var(--danger, #D93A2B)' : left <= 20 ? '#E0A100' : 'var(--ink)'
  return (
    <span className="ring" aria-label={`${left} characters left`}>
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r={r} fill="none" stroke="var(--line)" strokeWidth="2" />
        <circle cx="12" cy="12" r={r} fill="none" stroke={tone} strokeWidth="2" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} strokeLinecap="round" transform="rotate(-90 12 12)" />
      </svg>
      {left <= 20 && <span className={`ring__n num ${left < 0 ? 'warn' : ''}`}>{left}</span>}
    </span>
  )
}

/** Put a fresh drop at the top of the feeds that should show it straight away. */
export function prependToFeeds(qc: ReturnType<typeof useQueryClient>, d: ApiDrop) {
  for (const tab of ['foryou', 'following']) {
    qc.setQueryData<InfiniteData<Page, string>>(['feed', tab], old => {
      if (!old?.pages.length) return old
      const [first, ...rest] = old.pages
      return { ...old, pages: [{ ...first, items: [d, ...first.items.filter(i => i.id !== d.id)] }, ...rest] }
    })
  }
}

export function Composer({ replyTo, quoteOf, onDone, autoFocus, placeholder, compact, preview, children, submitLabel, extra, canSubmit = true }: {
  replyTo?: string; quoteOf?: string; onDone?: (p: Post | null) => void; autoFocus?: boolean; placeholder?: string
  compact?: boolean; preview?: boolean; children?: ReactNode; submitLabel?: string
  /** Extra fields for POST /drops, e.g. { locked: { price, teaser } } or { supportersOnly: 't1' }. */
  extra?: Record<string, unknown>; canSubmit?: boolean
}) {
  const { me, expectMe, guest } = useSession()
  const submitRef = useRef<() => Promise<void>>(async () => {})
  const { toast, openSheet } = useStore()
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState(!!autoFocus)
  const ta = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const used = count(text)
  const over = used > DROP_CHARS
  const quoted = quoteOf ? getDrop(quoteOf) : undefined
  const ok = canSubmit && !busy && !uploading && !over && (!!text.trim() || !!image || !!quoteOf)

  useLayoutEffect(() => { // grow with the text
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(compact && !focused ? 44 : 72, el.scrollHeight)}px`
  }, [text, compact, focused])
  useEffect(() => { if (autoFocus) ta.current?.focus() }, [autoFocus])

  if (!me && expectMe) {
    return (
      <div className={`composer composer--skel ${compact ? 'composer--compact' : ''}`} aria-busy="true" aria-label="loading">
        <span className="skel skel--circle" />
        <div className="composer__main"><span className="skel composer__ph" style={compact ? undefined : { height: 72 }} /></div>
      </div>
    )
  }
  if (!me) {
    return (
      <div className={`composer composer--out ${compact ? 'composer--compact' : ''}`}>
        <span className="composer__out-copy">{replyTo ? 'sign in to reply.' : 'sign in to post.'}</span>
        <button className="btn btn--dark btn--sm" onClick={() => openSheet({ type: 'signin' })}>sign in</button>
      </div>
    )
  }

  const pick = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 5 * 1024 * 1024) { toast('that image is over 5 mb'); return }
    setUploading(true)
    try { setImage(await uploadImage(f)) } catch (e) { toast('upload failed', (e as Error).message) } finally { setUploading(false); if (file.current) file.current.value = '' }
  }

  const submit = async () => {
    if (!ok) return
    // a guest links first, then the same drop goes out
    if (guest) { openSheet({ type: 'link', then: () => void submitRef.current() }); return }
    if (preview) { toast('not posted', 'posting is off here'); onDone?.(null); return }
    setBusy(true)
    try {
      const r = await api<{ drop: ApiDrop }>('/drops', { method: 'POST', json: { text, image, replyTo: replyTo ?? null, quoteOf: quoteOf ?? null, ...extra } })
      const p = adoptDrop(r.drop)
      if (replyTo) {
        const parent = getDrop(replyTo)
        if (parent) setDrop({ ...parent, replies: parent.replies + 1 })
        qc.invalidateQueries({ queryKey: ['drop', replyTo] })
      } else prependToFeeds(qc, r.drop)
      if (quoteOf) { const q = getDrop(quoteOf); if (q) setDrop({ ...q, quotes: (q.quotes ?? 0) + 1 }) }
      qc.invalidateQueries({ queryKey: ['user', me.handle] })
      qc.invalidateQueries({ queryKey: ['udrops', me.handle] })
      setText(''); setImage(null); setFocused(false)
      toast(replyTo ? 'reply sent' : quoteOf ? 'quote dropped' : 'dropped. it’s live now')
      onDone?.(p)
    } catch (e) { toast('couldn’t drop that', (e as Error).message) } finally { setBusy(false) }
  }
  submitRef.current = submit

  const replyingTo = replyTo ? getDrop(replyTo)?.author : undefined
  const open = !compact || focused || !!text || !!image
  return (
    <div className={`composer ${compact ? 'composer--compact' : ''} ${open ? 'is-open' : ''}`}>
      <Avatar handle={me.handle} size={40} />
      <div className="composer__main">
        {replyingTo && <div className="muted small composer__to">replying to <span className="rt-link">@{replyingTo}</span></div>}
        <textarea ref={ta} value={text} rows={compact && !focused ? 1 : 3} aria-label={replyTo ? 'your reply' : 'your drop'}
          placeholder={placeholder ?? (replyTo ? 'drop your reply' : 'what’s happening?')}
          onFocus={() => setFocused(true)} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() } }} />
        <AnimatePresence initial={false}>
          {image && (
            <motion.div className="composer__img" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <img src={image} alt="" />
              <button className="composer__img-x" aria-label="remove image" onClick={() => setImage(null)}><Icon name="close" size={16} /></button>
            </motion.div>
          )}
        </AnimatePresence>
        {quoteOf && <QuoteEmbed post={quoted} />}
        {open && children}
        {open && (
          <div className="composer__bar">
            <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={e => pick(e.target.files?.[0])} />
            <button className="act act--icon" aria-label="add an image" disabled={uploading || !!image} onClick={() => file.current?.click()}>
              {uploading ? <span className="spinner spinner--sm" /> : <Icon name="image" size={18} />}
            </button>
            <span className="composer__spacer" />
            {used > 0 && <Ring used={used} max={DROP_CHARS} />}
            <motion.button whileTap={{ scale: 0.95 }} className="btn btn--dark btn--sm composer__go" disabled={!ok} onClick={submit}>
              {busy ? 'dropping…' : submitLabel ?? (replyTo ? 'reply' : 'drop it')}
            </motion.button>
          </div>
        )}
      </div>
    </div>
  )
}

export const nameOf = (h: string) => users[h]?.name ?? h
