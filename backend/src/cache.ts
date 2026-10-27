/**
 * Shared state for running several stateless replicas: rate limits, the price cache and pub/sub.
 * Uses Redis when REDIS_URL is set (Railway Redis), otherwise an in-memory fallback for local dev and tests.
 */
import { Redis } from 'ioredis'
import { onWrite } from './db'
import { envInt, Lru } from './lru'

type Sub = (msg: string) => void
interface Store {
  kind: 'redis' | 'memory'
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlMs: number): Promise<void>
  /** Sliding-window-ish counter: increments and returns the count within the window. */
  hit(key: string, windowMs: number): Promise<number>
  publish(channel: string, msg: string): Promise<void>
  subscribe(channel: string, fn: Sub): () => void
  ping(): Promise<boolean>
  reset(): void
  /** Entries held locally (memory store only). */
  size?: () => number
  /** Tracked rate-limit keys (memory store only). */
  rateKeys?: () => number
}

/** Entry cap for the in-memory store (CACHE_MAX_ENTRIES) and an approximate byte cap (CACHE_MAX_BYTES, UTF-16 length x2). */
export const CACHE_MAX_ENTRIES = envInt('CACHE_MAX_ENTRIES', 5000)
export const CACHE_MAX_BYTES = envInt('CACHE_MAX_BYTES', 64 * 1024 * 1024)
const RATE_MAX_KEYS = envInt('RATE_MAX_KEYS', 200_000)
/** Hits remembered per key, newest kept (the largest limit in the app is 300 per window, so a key at the cap is over every limit). */
export const RATE_MAX_HITS = envInt('RATE_MAX_HITS', 512)
export const OVERFLOW_BUCKETS = 256

/** 32-bit FNV-1a: stable across restarts and replicas, fast, good enough spread for bucketing. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}
/** "signup:ip:1.2.3.4" -> "signup" (ipv6 keys have colons too, so only the first segment is the rule). */
const ruleOf = (k: string) => { const i = k.indexOf(':'); return i < 0 ? k : k.slice(0, i) }
/** Which overflow bucket a key falls into once the table is full: per rule and window, 256 buckets by key hash. */
export const overflowBucket = (k: string, w: number) => `${ruleOf(k)}|${w}|${fnv1a(k) % OVERFLOW_BUCKETS}`

function memory(): Store {
  const kv = new Lru<string, string>({ max: CACHE_MAX_ENTRIES, maxBytes: CACHE_MAX_BYTES, size: v => v.length * 2 })
  // Rate-limit windows: each key lives one window past its last hit. A key whose window is still open is never
  // evicted (the LRU's cap sits above RATE_MAX_KEYS and new keys stop being admitted at it), so flooding the table
  // with fresh keys can't reset anyone's count. When it's full of open windows, new keys fail closed into shared
  // overflow buckets (rule + window + hash(key) % 256) until expired keys are swept out: a flood still runs into
  // limits fast, while an ordinary newcomer usually shares a bucket with ~1/256 of the flood, not all of it.
  // Footprint at the 200k default: measured ~360 bytes per live key (key string, 2 timestamps, LRU node) = ~70 MB when full;
  // each key keeps at most RATE_MAX_HITS timestamps, and overflow buckets are capped at 128 x 256.
  const hits = new Lru<string, number[]>({ max: RATE_MAX_KEYS + 1 })
  const overflow = new Lru<string, number[]>({ max: 128 * OVERFLOW_BUCKETS }) // room for 128 rule/window pairs (the app has ~20); each bucket expires with its window
  let lastFullSweep = 0
  // exact-size arrays (filter+push leaves ~16 slots of slack per key, which is most of the footprint at 200k keys)
  const count = (arr: number[] | undefined, t: number, w: number) => {
    let from = 0
    const n = arr?.length ?? 0
    while (from < n && t - arr![from] >= w) from++ // hits are appended in time order
    if (n - from >= RATE_MAX_HITS) from = n - RATE_MAX_HITS + 1
    const a = new Array<number>(n - from + 1)
    for (let i = from; i < n; i++) a[i - from] = arr![i]
    a[n - from] = t
    return a
  }
  // the count is the window's hits, capped (but never reported under the cap's real total)
  const seen = (a: number[], before: number[] | undefined) => (a.length === RATE_MAX_HITS && (before?.length ?? 0) >= RATE_MAX_HITS ? RATE_MAX_HITS + 1 : a.length)
  const subs = new Map<string, Set<Sub>>()
  return {
    kind: 'memory',
    async get(k) { return kv.get(k) ?? null },
    async set(k, v, ttl) { kv.set(k, v, ttl) },
    async hit(k, w) {
      const t = Date.now()
      const cur = hits.peek(k)
      if (cur === undefined && hits.size >= RATE_MAX_KEYS) {
        if (t - lastFullSweep > 1000) { lastFullSweep = t; hits.sweep() } // at most once a second
        if (hits.size >= RATE_MAX_KEYS) {
          const ob = overflowBucket(k, w), prev = overflow.peek(ob)
          const a = count(prev, t, w); overflow.set(ob, a, w)
          return seen(a, prev)
        }
      }
      const arr = count(cur, t, w)
      hits.set(k, arr, w)
      return seen(arr, cur)
    },
    async publish(ch, msg) { for (const fn of subs.get(ch) ?? []) fn(msg) },
    subscribe(ch, fn) {
      const s = subs.get(ch) ?? new Set(); s.add(fn); subs.set(ch, s)
      return () => { s.delete(fn); if (!s.size && subs.get(ch) === s) subs.delete(ch) }
    },
    async ping() { return true },
    reset() { kv.clear(); hits.clear(); overflow.clear() },
    rateKeys: () => hits.size,
    size: () => kv.size,
  }
}

function redis(url: string): Store {
  const r = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false })
  let sub: Redis | null = null
  const handlers = new Map<string, Set<Sub>>()
  r.on('error', e => console.error('[redis]', e.message))
  return {
    kind: 'redis',
    get: k => r.get(k),
    async set(k, v, ttl) { await r.set(k, v, 'PX', ttl) },
    async hit(k, w) {
      // Fixed window per key (cheap, atomic): INCR + PEXPIRE on first hit.
      const key = `rl:${k}:${Math.floor(Date.now() / w)}`
      const n = await r.incr(key)
      if (n === 1) await r.pexpire(key, w)
      return n
    },
    async publish(ch, msg) { await r.publish(ch, msg) },
    subscribe(ch, fn) {
      if (!sub) {
        sub = r.duplicate()
        sub.on('message', (c: string, m: string) => { for (const f of handlers.get(c) ?? []) f(m) })
      }
      const s = handlers.get(ch) ?? new Set()
      if (!s.size) void sub.subscribe(ch)
      s.add(fn); handlers.set(ch, s)
      return () => { s.delete(fn) }
    },
    async ping() { try { return (await r.ping()) === 'PONG' } catch { return false } },
    reset() {},
  }
}

export const store: Store = process.env.REDIS_URL ? redis(process.env.REDIS_URL) : memory()

// ------------------------------------------------------------------ read cache

/**
 * Hot-read cache on top of the store. Each entry lives under its namespaces' current generations, so a write
 * anywhere in a namespace (new drop, tip, vote, follow, profile edit, name claim) retires every entry at once by
 * bumping the generation. No key scans, and it works the same in memory and in Redis.
 *
 * Reads are stale-while-revalidate: past `ttlMs` (but within `staleMs`) the old value is served right away and one
 * background refresh runs. Concurrent misses for the same key share one computation.
 */
export type Ns = 'feed' | 'drop' | 'users' | 'creators' | 'names' | 'rpc'
const ALL_NS: Ns[] = ['feed', 'drop', 'users', 'creators', 'names', 'rpc']
const GEN_TTL = 7 * 86400_000
const localGen = new Map<Ns, string>()
const inflight = new Map<string, Promise<unknown>>()
const stats = { hit: 0, stale: 0, miss: 0 }

async function gens(ns: Ns[]): Promise<string> {
  if (store.kind === 'memory') return ns.map(n => localGen.get(n) ?? '0').join('.')
  const vals = await Promise.all(ns.map(n => store.get(`gen:${n}`).catch(() => null)))
  return vals.map(v => v ?? '0').join('.')
}

/** Retire everything cached under these namespaces (all replicas when Redis is on). */
export async function invalidate(...ns: Ns[]) {
  if (!ns.length) return
  const v = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  for (const n of ns) localGen.set(n, v)
  if (store.kind === 'redis') await Promise.all(ns.map(n => store.set(`gen:${n}`, v, GEN_TTL).catch(() => {})))
}

export async function cached<T>(ns: Ns[], key: string, ttlMs: number, fn: () => Promise<T>, staleMs = ttlMs * 4): Promise<T> {
  if (process.env.CACHE_OFF === '1') return fn()
  const k = `c:${ns.join(',')}:${await gens(ns)}:${key}`
  const raw = await store.get(k).catch(() => null)
  const refresh = () => {
    let p = inflight.get(k) as Promise<T> | undefined
    if (!p) {
      p = (async () => {
        try { const v = await fn(); await store.set(k, JSON.stringify({ v, at: Date.now() }), staleMs).catch(() => {}); return v }
        finally { inflight.delete(k) }
      })()
      inflight.set(k, p)
    }
    return p
  }
  if (raw) {
    const e = JSON.parse(raw) as { v: T; at: number }
    if (Date.now() - e.at < ttlMs) { stats.hit++; return e.v }
    stats.stale++
    void refresh().catch(() => {}) // serve stale now, refresh behind
    return e.v
  }
  stats.miss++
  return refresh()
}

/** Chain reads: long-lived SWR so a slow or down RPC never holds up a page; failures fall back to the last value. */
export function rpcCached<T>(key: string, ttlMs: number, fn: () => Promise<T>) {
  return cached(['rpc'], key, ttlMs, fn, Math.max(ttlMs * 20, 10 * 60_000))
}

export function cacheStats() { return { kind: store.kind, ...stats, entries: store.size?.() ?? null } }

/**
 * Which namespaces a write retires, by the table it touches. Every write goes through db.run, so background jobs
 * (keeper, dca, name sync) retire caches the same way request handlers do. Tables nothing cached reads from
 * (sessions, notifications, keeper runs, nonces...) retire nothing.
 */
const TABLE_NS: Record<string, Ns[]> = {
  drops: ['feed', 'drop', 'users', 'creators'], drops_fts: [], likes: ['feed', 'drop', 'users', 'creators'],
  passes: ['feed', 'drop', 'users'], tips: ['feed', 'drop', 'users', 'creators'], votes: ['feed', 'drop', 'creators'],
  bookmarks: ['feed', 'drop'], not_interested: ['feed'], follows: ['feed', 'drop', 'users', 'creators'],
  mutes: ['feed', 'drop', 'users', 'creators'], blocks: ['feed', 'drop', 'users', 'creators'],
  users: ['users', 'feed', 'drop', 'creators', 'names'], privy_accounts: ['users', 'names'],
  names: ['names', 'users', 'feed', 'drop', 'creators', 'rpc'], name_records: ['names', 'users', 'rpc'],
  name_listings: ['names', 'users'], name_offers: ['names'], name_sales: ['names'], handle_history: ['users', 'names'],
  badges: ['users', 'feed', 'drop'], badge_burns: ['users', 'feed', 'drop'], plus_subs: ['users', 'feed', 'drop'], plus_payments: ['users', 'feed', 'drop'],
  unlocks: ['feed', 'drop'], tags: ['feed'], handle_bumps: ['users', 'names'], llm_usage: [],
}
const IGNORE = /^(sessions|nonces|notifications|keeper_runs|dca_|agent_|maint_runs|uploads)/
const WRITE_RE = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|REPLACE\s+INTO)\s+"?(\w+)/i
export function nsForSql(sql: string): Ns[] {
  const m = WRITE_RE.exec(sql)
  if (!m) return []
  const t = m[1].toLowerCase()
  if (t in TABLE_NS) return TABLE_NS[t]
  return IGNORE.test(t) ? [] : ALL_NS // unknown table: retire everything (safe default)
}

onWrite(sql => { const ns = nsForSql(sql); if (ns.length) void invalidate(...ns) })
