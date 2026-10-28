/**
 * Direct messages: types, the live stream (server-sent events, with polling as the fallback) and small cache helpers.
 * Every message renders as plain text nodes; links are made by RichText, never by html.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import { api, adoptUser, type ApiUser } from './client'

export type DmMessage = { id: number; mine: boolean; kind: 'text' | 'tip'; text: string; image: string | null; tip: { amount: number; txHash: string | null; verified: boolean } | null; at: number; pending?: boolean }
export type DmInboxItem = { peer: ApiUser; last: DmMessage | null; unread: number; at: number; request: boolean }
export type DmUnread = { inbox: number; requests: number }
export type DmInbox = { items: DmInboxItem[]; next: string | null; unread: DmUnread }
export type DmThread = {
  peer: ApiUser; blocked: 'you' | 'them' | null; canMessage: boolean; request: boolean; pending: boolean
  items: DmMessage[]; next: string | null; peerRead: number; myRead?: number
}
type Live = { type: 'msg'; peer: string; message: DmMessage } | { type: 'read'; peer: string; upTo: number } | { type: 'typing'; peer: string } | { type: 'hide'; peer: string; id: number } | { type: 'block'; peer: string }

export const DM_CHARS = 2000
export const DM_IMAGE_MAX = 20 * 1024 * 1024
export const DM_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export async function uploadDmImage(file: File): Promise<string> {
  const fd = new FormData(); fd.append('file', file)
  return (await api<{ url: string }>('/uploads?kind=dm', { method: 'POST', body: fd })).url
}

export const threadKey = (handle: string) => ['dms', 'thread', handle.toLowerCase()] as const
export const inboxKey = (tab: 'inbox' | 'requests') => ['dms', 'list', tab] as const

export async function fetchThread(handle: string, before?: string | null): Promise<DmThread> {
  const t = await api<DmThread>(`/dms/${encodeURIComponent(handle)}${before ? `?before=${encodeURIComponent(before)}` : ''}`)
  adoptUser(t.peer)
  return t
}
export async function fetchInbox(tab: 'inbox' | 'requests', cursor?: string | null): Promise<DmInbox> {
  const r = await api<DmInbox>(`/dms?tab=${tab}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
  r.items.forEach(i => adoptUser(i.peer))
  return r
}

/** newest page first; each page is oldest-to-newest inside */
type Pages = InfiniteData<DmThread, string | null>
export function editThread(qc: QueryClient, handle: string, f: (first: DmThread, all: Pages) => Pages) {
  qc.setQueryData<Pages>(threadKey(handle), d => d && d.pages[0] ? f(d.pages[0], d) : d)
}
export function addMessage(qc: QueryClient, handle: string, m: DmMessage, replaceId?: number) {
  editThread(qc, handle, (first, d) => {
    if (d.pages.some(p => p.items.some(x => x.id === m.id))) {
      return replaceId === undefined ? d : { ...d, pages: d.pages.map(p => ({ ...p, items: p.items.filter(x => x.id !== replaceId) })) }
    }
    const items = replaceId !== undefined && first.items.some(x => x.id === replaceId) ? first.items.map(x => x.id === replaceId ? m : x) : [...first.items, m]
    return { ...d, pages: [{ ...first, items }, ...d.pages.slice(1)] }
  })
}
export function dropMessage(qc: QueryClient, handle: string, id: number) {
  editThread(qc, handle, (_f, d) => ({ ...d, pages: d.pages.map(p => ({ ...p, items: p.items.filter(x => x.id !== id) })) }))
}

// live state: on while the stream is open; the pages poll faster while it isn't
let live = false
const subs = new Set<() => void>()
const setLive = (v: boolean) => { if (live !== v) { live = v; subs.forEach(f => f()) } }
export function useDmLiveOn() { return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => live) }

const typing = new Map<string, number>()
const typingSubs = new Set<() => void>()
export function useTyping(handle: string) {
  const at = useSyncExternalStore(f => { typingSubs.add(f); return () => { typingSubs.delete(f) } }, () => typing.get(handle.toLowerCase()) ?? 0)
  return at > 0 && Date.now() - at < 6000
}
function setTyping(h: string, v: number) { typing.set(h.toLowerCase(), v); typingSubs.forEach(f => f()) }

/** One stream per tab while signed in. Reconnects on its own (server sends retry); after repeated failures it stops and polling takes over. */
export function useDmStream(on: boolean) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!on || typeof EventSource === 'undefined') return
    let es: EventSource | null = null
    let fails = 0
    let stopped = false
    let timer = 0
    let opened = 0
    const open = () => {
      if (stopped) return
      es = new EventSource('/api/dms/stream', { withCredentials: true })
      es.addEventListener('ready', () => { fails = 0; setLive(true); if (opened++) qc.invalidateQueries({ queryKey: ['dms'] }) })
      es.addEventListener('dm', e => {
        let ev: Live
        try { ev = JSON.parse((e as MessageEvent).data) } catch { return }
        if (ev.type === 'msg') {
          setTyping(ev.peer, 0)
          addMessage(qc, ev.peer, ev.message)
          qc.invalidateQueries({ queryKey: ['dms', 'list'] })
          if (!ev.message.mine) qc.invalidateQueries({ queryKey: ['me'] })
        } else if (ev.type === 'read') {
          const upTo = ev.upTo
          editThread(qc, ev.peer, (first, d) => ({ ...d, pages: [{ ...first, peerRead: Math.max(first.peerRead, upTo) }, ...d.pages.slice(1)] }))
        } else if (ev.type === 'typing') {
          setTyping(ev.peer, Date.now())
          window.setTimeout(() => typingSubs.forEach(f => f()), 6100)
        } else if (ev.type === 'hide') {
          dropMessage(qc, ev.peer, ev.id)
          qc.invalidateQueries({ queryKey: ['dms', 'list'] })
        } else if (ev.type === 'block') {
          qc.invalidateQueries({ queryKey: ['dms'] })
          qc.invalidateQueries({ queryKey: ['me'] })
        }
      })
      es.onerror = () => {
        setLive(false)
        if (es?.readyState === EventSource.CLOSED) {
          es.close(); fails++
          if (fails < 6) timer = window.setTimeout(open, Math.min(30_000, 2000 * 2 ** fails))
        }
      }
    }
    // Close before the page goes into the back/forward cache (an open stream there keeps a connection busy), reopen on return.
    const hide = () => { window.clearTimeout(timer); es?.close(); es = null; setLive(false) }
    const show = (e: PageTransitionEvent) => { if (e.persisted && !stopped && !es) { fails = 0; open() } }
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', show)
    open()
    return () => { stopped = true; window.clearTimeout(timer); es?.close(); setLive(false); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show) }
  }, [on, qc])
}
