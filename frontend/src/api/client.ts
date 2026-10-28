/**
 * wifly api client. Talks to backend/ through the same-origin /api proxy (see vite.config.ts).
 * Every write carries `x-wifly: 1` (the server's CSRF check) and the session rides in an httpOnly cookie.
 */
import type { Media, Post, User } from '../state/registry'

export type ApiUser = {
  handle: string; name: string; bio: string; avatar: string | null; location: string | null; tone: number
  plus: boolean; creator: boolean; joined: number; address: string | null
  followers: number; following: number; drops: number
  youFollow: boolean; followsYou: boolean; you: boolean; muted: boolean
  supporters?: number; dmPrice?: number; tiers?: unknown; shop?: unknown; seed: boolean
  reason?: string; onboarded?: boolean; wifName?: string | null; plusGrace?: boolean; badge?: string | null
  blocked?: boolean; blocksYou?: boolean
}
export type ApiDrop = {
  id: string; author: ApiUser; text: string; image: string | null; media: unknown; locked: unknown; supportersOnly: string | null
  replyTo: string | null; replyToHandle: string | null; rootId: string | null; quote: ApiDrop | null; quoteMissing: boolean
  createdAt: number; likes: number; replies: number; passes: number; quotes: number; tipped: number; votes: number
  liked: boolean; passed: boolean; bookmarked: boolean; mine: boolean; deleted: boolean; tags: string[]
  passedBy?: string; passedAt?: number; seed: boolean; why?: string
}
export type Page = { items: ApiDrop[]; next: string | null; snapshot?: number; signedOut?: boolean; guest?: { limit: number; more: boolean } }
export type Notif = { id: string; kind: 'like' | 'pass' | 'reply' | 'quote' | 'follow' | 'mention' | 'tip' | 'name_offer' | 'name_offer_accepted' | 'handle_bump'; actors: ApiUser[]; count: number; drop: ApiDrop | null; meta: Record<string, unknown>; read: boolean; createdAt: number }
export type Limits = { dropChars: number; bioChars: number; nameChars: number; handleMin: number; handleMax: number; imageBytes: number }

export class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message) } }
/** A guest tried a write that needs a linked wallet, x or email: the app opens the link sheet. */
export const LINK_REQUIRED_EVENT = 'wifly:link-required'

/**
 * Session epoch. Every request is tagged with the epoch it started in; sign-out moves the epoch on and aborts what
 * is in flight, so a late answer from the old session can never land in the next account's screens.
 */
let epoch = 0
let inflight = new AbortController()
export const sessionEpoch = () => epoch
export function endSessionEpoch() { epoch++; inflight.abort(); inflight = new AbortController() }
export class StaleSessionError extends ApiError { constructor() { super(0, 'signed out', 'stale_session') } }
/** Throws when a response belongs to an older session than the one now on screen. */
export function checkEpoch(started: number) { if (started !== epoch) throw new StaleSessionError() }
export function epochSignal(own?: AbortSignal | null): AbortSignal {
  if (!own) return inflight.signal
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  return any ? any([own, inflight.signal]) : own
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const method = (rest.method ?? 'GET').toUpperCase()
  const started = epoch
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    signal: epochSignal(rest.signal),
    headers: {
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-wifly': '1' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  }).catch(e => { checkEpoch(started); throw e })
  checkEpoch(started)
  if (!res.ok) {
    let msg = res.statusText, code: string | undefined
    try { const b = await res.json(); msg = b.error ?? msg; code = typeof b.code === 'string' ? b.code : undefined } catch { /* not json */ }
    if (res.status === 502 || res.status === 504) msg = 'the wifly api isn’t running (cd backend && npm run dev)'
    if (code === 'link_required' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LINK_REQUIRED_EVENT))
    checkEpoch(started)
    throw new ApiError(res.status, msg, code)
  }
  const body = await res.json() as T
  checkEpoch(started)
  return body
}

export async function uploadImage(file: File): Promise<string> {
  const fd = new FormData(); fd.append('file', file)
  const r = await api<{ url: string }>('/uploads', { method: 'POST', body: fd })
  return r.url
}

export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const AVATAR_MAX_BYTES = 20 * 1024 * 1024 // same as the api's AVATAR_MAX_BYTES
export const AVATAR_TOO_BIG = 'photo must be under 20 MB'

/** Problem with a chosen profile photo, in plain words, or null when it's fine. */
export function avatarProblem(f: File): string | null {
  if (!AVATAR_TYPES.includes(f.type)) return 'use a png, jpg, webp or gif photo'
  if (f.size > AVATAR_MAX_BYTES) return AVATAR_TOO_BIG
  return null
}

/** Square-crop and shrink a photo to 512 px WebP (JPEG if WebP isn't supported) so stored avatars stay small. */
async function shrinkAvatar(f: File, px = 512): Promise<File> {
  try {
    const bmp = await createImageBitmap(f)
    const side = Math.min(bmp.width, bmp.height), out = Math.min(px, side)
    const c = document.createElement('canvas'); c.width = out; c.height = out
    c.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out)
    bmp.close?.()
    const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/webp', 0.86))
      ?? await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.86))
    if (!blob || (blob.size >= f.size && f.size < 1024 * 1024)) return f
    return new File([blob], blob.type === 'image/webp' ? 'avatar.webp' : 'avatar.jpg', { type: blob.type })
  } catch { return f }
}

/** Profile photo upload: checks type and the 20 MB cap, shrinks it, then posts with kind=avatar. */
export async function uploadAvatar(file: File): Promise<string> {
  const bad = avatarProblem(file)
  if (bad) throw new Error(bad)
  const fd = new FormData(); fd.append('file', await shrinkAvatar(file))
  const r = await api<{ url: string }>('/uploads?kind=avatar', { method: 'POST', body: fd })
  return r.url
}

// ---------------------------------------------------------------------------
// Registry: api users and drops are merged into the shared `users` / `posts`
// collections so the $WIF sheets (tip, unlock, vote …) keep finding them by id.
// ---------------------------------------------------------------------------
import { posts, users } from '../state/registry'

const listeners = new Set<() => void>()
let version = 0
export const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const getVersion = () => version
let queued = false
function notify() {
  if (queued) return
  queued = true
  queueMicrotask(() => { queued = false; version++; listeners.forEach(l => l()) })
}

export function relTime(ts: number, now = Date.now()) {
  const s = Math.max(0, (now - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toLowerCase()
}

export function adoptUser(a: ApiUser): User {
  const prev = users[a.handle]
  const u: User = {
    ...(prev ?? {}),
    handle: a.handle, name: a.name, bio: a.bio, avatar: a.avatar, location: a.location ?? undefined,
    joined: new Date(a.joined).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
    followers: a.followers, following: a.following, drops: a.drops, tone: a.tone,
    plus: a.plus, creator: a.creator, youFollow: a.youFollow, followsYou: a.followsYou, muted: a.muted, you: a.you, seed: a.seed,
    address: (a.address ?? undefined) as User['address'], wifName: a.wifName ?? null, plusGrace: a.plusGrace, badge: a.badge ?? prev?.badge,
    supporters: a.supporters ?? prev?.supporters, dmPrice: a.dmPrice ?? prev?.dmPrice, blocked: !!a.blocked, blocksYou: !!a.blocksYou,
    tiers: (a.tiers as User['tiers']) ?? prev?.tiers, shop: (a.shop as User['shop']) ?? prev?.shop,
  }
  // a new account has no public @name until onboarding picks one: keep it out of the registry by name
  if (a.handle) users[a.handle] = u
  if (a.you) users.you = { ...u, handle: a.handle }
  notify()
  return u
}

export function patchUser(handle: string, patch: Partial<User>) {
  const u = users[handle]
  if (!u) return
  users[handle] = { ...u, ...patch }
  if (u.you) users.you = { ...users[handle] }
  notify()
}

const live = new Map<string, Post>()
export const getDrop = (id: string) => live.get(id)

function toPost(d: ApiDrop): Post {
  adoptUser(d.author)
  return {
    id: d.id, author: d.author.handle, text: d.text, time: relTime(d.createdAt), createdAt: d.createdAt,
    likes: d.likes, reposts: d.passes, replies: d.replies, quotes: d.quotes, tipped: d.tipped, votes: d.votes,
    feed: [], media: (d.media as Media) ?? undefined, locked: (d.locked as Post['locked']) ?? undefined,
    supportersOnly: d.supportersOnly ?? undefined, replyTo: d.replyTo ?? undefined, replyToHandle: d.replyToHandle,
    image: d.image, quote: d.quote ? adoptDrop(d.quote) : null, quoteMissing: d.quoteMissing,
    liked: d.liked, passed: d.passed, bookmarked: d.bookmarked, mine: d.mine, deleted: d.deleted, tags: d.tags,
    seed: d.seed, server: true,
  }
}

export function setDrop(p: Post) {
  live.set(p.id, p)
  const i = posts.findIndex(x => x.id === p.id)
  if (i >= 0) posts[i] = p; else posts.push(p)
  notify()
}

/** Pending optimistic writes per drop: a stale server echo must not undo a newer tap. */
const pending = new Map<string, number>()

export function adoptDrop(d: ApiDrop): Post {
  const p = toPost(d)
  if (!pending.get(d.id)) setDrop(p)
  return live.get(d.id) ?? p
}
export const adoptDrops = (ds: ApiDrop[]) => ds.map(adoptDrop)

type Toggle = 'like' | 'pass' | 'bookmark'
const field: Record<Toggle, ['liked' | 'passed' | 'bookmarked', 'likes' | 'reposts' | null]> = {
  like: ['liked', 'likes'], pass: ['passed', 'reposts'], bookmark: ['bookmarked', null],
}

/** Optimistic like / pass it on / bookmark: flip now, send, then reconcile with what the server returns. */
export async function toggleDrop(id: string, kind: Toggle): Promise<void> {
  const cur = live.get(id)
  if (!cur) return
  const [flag, count] = field[kind]
  const on = !cur[flag]
  setDrop({ ...cur, [flag]: on, ...(count ? { [count]: Math.max(0, (cur[count] ?? 0) + (on ? 1 : -1)) } : {}) })
  pending.set(id, (pending.get(id) ?? 0) + 1)
  try {
    const r = await api<{ drop: ApiDrop }>(`/drops/${id}/${kind}`, { method: on ? 'POST' : 'DELETE' })
    const left = (pending.get(id) ?? 1) - 1
    pending.set(id, left)
    if (left === 0) setDrop(toPost(r.drop)) // last write wins; the server's counts are the truth
  } catch (e) {
    const left = (pending.get(id) ?? 1) - 1
    pending.set(id, left)
    const now = live.get(id)
    if (now) setDrop({ ...now, [flag]: !on, ...(count ? { [count]: Math.max(0, (now[count] ?? 0) + (on ? -1 : 1)) } : {}) })
    throw e
  }
}

export async function deleteDrop(id: string) {
  await api(`/drops/${id}`, { method: 'DELETE' })
  const cur = live.get(id)
  if (cur) setDrop({ ...cur, deleted: true })
}

export async function followUser(handle: string, on: boolean) {
  const u = users[handle]
  if (u) patchUser(handle, { youFollow: on, followers: Math.max(0, u.followers + (on ? 1 : -1)) })
  try {
    const r = await api<{ user: ApiUser }>(`/users/${handle}/follow`, { method: on ? 'POST' : 'DELETE' })
    if (r?.user) adoptUser(r.user)
  } catch (e) {
    const now = users[handle]
    if (now) patchUser(handle, { youFollow: !on, followers: Math.max(0, now.followers + (on ? -1 : 1)) })
    throw e
  }
}
