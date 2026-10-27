/** Data hooks: feeds, threads, profiles, notifications, search. Every drop that arrives is adopted into the registry. */
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryKey } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { adoptDrop, adoptDrops, adoptUser, api, type ApiDrop, type ApiUser, type Notif, type Page } from './client'
import type { Post } from '../state/registry'

export type FeedTab = 'foryou' | 'following' | 'crowd'
export type FeedRow = { post: Post; passedBy?: string; key: string; why?: string }

function rows(items: ApiDrop[]): FeedRow[] {
  return items.map(d => ({ post: adoptDrop(d), passedBy: d.passedBy, why: d.why, key: d.passedBy ? `${d.id}:${d.passedBy}` : d.id }))
}

/** One paged list with infinite scroll; `path` gets `cursor=` appended. */
export function usePaged(key: QueryKey, path: string, enabled = true, prefetch = false) {
  const q = useInfiniteQuery({
    queryKey: key, enabled, staleTime: 15_000,
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) => api<Page>(`${path}${path.includes('?') ? '&' : '?'}${pageParam ? `cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: last => last.next ?? undefined,
  })
  const list = useMemo(() => {
    const seen = new Set<string>()
    const out: FeedRow[] = []
    for (const pg of q.data?.pages ?? []) for (const r of rows(pg.items)) { if (!seen.has(r.key)) { seen.add(r.key); out.push(r) } }
    return out
  }, [q.data])
  const first = q.data?.pages[0]
  // warm the next page while the reader looks at the first, so scrolling never waits
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q
  const pages = q.data?.pages.length ?? 0
  useEffect(() => {
    if (!prefetch || pages !== 1 || !hasNextPage || isFetchingNextPage) return
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void }
    if (w.requestIdleCallback) { const h = w.requestIdleCallback(() => { void fetchNextPage() }, { timeout: 2500 }); return () => w.cancelIdleCallback?.(h) }
    const t = setTimeout(() => { void fetchNextPage() }, 1200); return () => clearTimeout(t)
  }, [prefetch, pages, hasNextPage, isFetchingNextPage, fetchNextPage])
  return { ...q, rows: list, signedOut: !!first?.signedOut, snapshot: first?.snapshot, guest: first?.guest }
}

export function useFeed(tab: FeedTab) {
  return usePaged(['feed', tab], `/feed?tab=${tab}`, true, true)
}

/** Polls for drops newer than the top of the feed; refresh() pulls them in. */
export function useNewDrops(tab: FeedTab, since: number | undefined) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['feed-new', tab, since], enabled: !!since,
    queryFn: () => api<{ count: number; authors?: string[] }>(`/feed/new?tab=${tab}&since=${since}`),
    refetchInterval: 30_000,
  })
  return {
    count: q.data?.count ?? 0, authors: q.data?.authors ?? [],
    refresh: async () => {
      // keep what's on screen while the fresh first page loads; no flash to empty
      qc.setQueryData<InfiniteData<Page, string>>(['feed', tab], d => d && { pages: d.pages.slice(0, 1), pageParams: d.pageParams.slice(0, 1) })
      await qc.invalidateQueries({ queryKey: ['feed', tab] }); qc.setQueryData(['feed-new', tab, since], { count: 0 }) },
  }
}

export function useThread(id: string) {
  return useQuery({
    queryKey: ['drop', id], staleTime: 10_000,
    queryFn: async () => {
      const r = await api<{ drop: ApiDrop; ancestors: ApiDrop[]; replies: ApiDrop[]; next: string | null }>(`/drops/${id}`)
      return { drop: adoptDrop(r.drop), ancestors: adoptDrops(r.ancestors), replies: adoptDrops(r.replies), next: r.next }
    },
    retry: (n, e) => (e as { status?: number }).status !== 404 && n < 1,
  })
}

export function useProfile(handle: string, enabled = true) {
  return useQuery({
    queryKey: ['user', handle], enabled, staleTime: 15_000,
    queryFn: async () => {
      const r = await api<{ user?: ApiUser; redirect?: string; formerly?: { name: string; until: number } | null }>(`/users/${handle}`)
      // old @name links follow the account to its new name
      if (r.redirect) throw Object.assign(new Error('moved'), { redirect: r.redirect, status: 301 })
      return { ...adoptUser(r.user!), formerly: r.formerly ?? null }
    },
    retry: (n, e) => { const s = (e as { status?: number }).status; return s !== 404 && s !== 301 && n < 1 },
  })
}

export function useNotifications(enabled = true) {
  return useInfiniteQuery({
    queryKey: ['notifications'],
    enabled, // signed-out visitors have no notifications; asking would only 401
    initialPageParam: '' as string,
    queryFn: async ({ pageParam }) => {
      const r = await api<{ items: Notif[]; next: string | null }>(`/notifications${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`)
      r.items.forEach(n => { n.actors.forEach(adoptUser); if (n.drop) adoptDrop(n.drop) })
      return r
    },
    getNextPageParam: last => last.next ?? undefined,
  })
}

export type SearchType = 'top' | 'people' | 'drops' | 'tags'
export function useSearch(q: string, type: SearchType) {
  return useInfiniteQuery({
    queryKey: ['search', q, type],
    placeholderData: keepPreviousData, // typing keeps the last results up instead of blanking
    initialPageParam: '' as string,
    queryFn: async ({ pageParam }) => {
      const r = await api<{ users: ApiUser[]; tags: { tag: string; drops: number }[]; drops: ApiDrop[]; next: string | null }>(
        `/search?q=${encodeURIComponent(q)}&type=${type}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`)
      r.users.forEach(adoptUser)
      return { ...r, posts: adoptDrops(r.drops) }
    },
    getNextPageParam: last => last.next ?? undefined,
  })
}

/** Debounced value for search-as-you-type. */
export function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v)
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms])
  return d
}

/** Burn counters from the backend's shared cache (one RPC read per 30s for everyone, not one per visitor). */
export type BurnStats = { burnAddressWif: number | null; burnedViaWifly: number | null; live: boolean; at: number }
export function useBurnStats() {
  const q = useQuery({ queryKey: ['burn'], queryFn: () => api<BurnStats>('/burn'), refetchInterval: 30_000, staleTime: 15_000 })
  return { value: q.data?.burnAddressWif ?? undefined, viaWifly: q.data?.burnedViaWifly ?? undefined, pending: q.isPending && !q.isError }
}
