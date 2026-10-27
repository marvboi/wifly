/**
 * Bounded in-memory map for every process-local cache: LRU by entry count (and optionally by approximate bytes),
 * per-entry expiry, expired entries swept a few at a time on each set plus on an unref'd timer, so memory stays
 * flat even when every write uses a fresh key and nothing is ever read back.
 */
const timers = new Set<Lru<unknown, unknown>>()
let timer: ReturnType<typeof setInterval> | null = null
const SWEEP_MS = 30_000
function track(l: Lru<unknown, unknown>) {
  timers.add(l)
  if (!timer) { timer = setInterval(() => { for (const x of timers) x.sweep() }, SWEEP_MS); timer.unref?.() }
}

export type LruOpts<V> = {
  /** Max entries; the least recently used is evicted past it. */
  max: number
  /** Optional cap on the summed `size(v)`; evicts oldest until under it. */
  maxBytes?: number
  size?: (v: V) => number
  /** Default time-to-live; Infinity keeps entries until evicted by the bound. */
  ttlMs?: number
}

export class Lru<K, V> {
  private m = new Map<K, { v: V; exp: number; b: number }>()
  private bytes = 0
  constructor(private o: LruOpts<V>) { track(this as Lru<unknown, unknown>) }
  get size() { return this.m.size }
  get approxBytes() { return this.bytes }
  get(k: K): V | undefined {
    const e = this.m.get(k)
    if (!e) return undefined
    if (e.exp <= Date.now()) { this.drop(k, e); return undefined }
    this.m.delete(k); this.m.set(k, e) // move to the end: most recently used
    return e.v
  }
  /** Read without touching recency or expiry (for callers that judge freshness themselves). */
  peek(k: K): V | undefined { const e = this.m.get(k); return e && e.exp > Date.now() ? e.v : undefined }
  has(k: K) { return this.peek(k) !== undefined }
  set(k: K, v: V, ttlMs = this.o.ttlMs ?? Infinity) {
    const old = this.m.get(k)
    if (old) this.drop(k, old)
    const b = this.o.size ? this.o.size(v) : 0
    this.m.set(k, { v, exp: Date.now() + ttlMs, b }); this.bytes += b
    this.sweep(4) // amortized: a few of the oldest per set
    while (this.m.size > this.o.max || (this.o.maxBytes && this.bytes > this.o.maxBytes && this.m.size > 1)) {
      const first = this.m.keys().next()
      if (first.done) break
      this.drop(first.value, this.m.get(first.value)!)
    }
    return this
  }
  delete(k: K) { const e = this.m.get(k); if (e) this.drop(k, e); return !!e }
  clear() { this.m.clear(); this.bytes = 0 }
  keys() { return this.m.keys() }
  /** Drops expired entries: the first `limit` in LRU order, or all when omitted. */
  sweep(limit = Infinity) {
    const t = Date.now()
    let seen = 0
    for (const [k, e] of this.m) {
      if (seen++ >= limit) break
      if (e.exp <= t) this.drop(k, e)
    }
  }
  private drop(k: K, e: { b: number }) { this.m.delete(k); this.bytes -= e.b }
}

export const envInt = (name: string, def: number) => {
  const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : def
}
