/**
 * Timelines. Formula doc: docs/TIMELINE.md (keep the two in sync).
 *
 * 'For you' is ranked. Every candidate drop (top-level, last 7 days) gets
 *
 *   score = (1 + engagement) × velocity × recency × affinity × interest × trust × media × notInterested
 *
 *   engagement  = ln(1 + likes + 2·replies + 2.5·passes + 2.5·quotes + 1.5·bookmarks) + 1.5·ln(1 + tipped/10) + 1.5·ln(1 + votes/10)
 *   velocity    = 1 + 0.4·min(2.5, ln(1 + (likes + 2·replies + 3·ln(1 + tipped/10)) / max(1, ageHours)))   ← fast-rising drops
 *   recency     = 0.5 ^ (ageHours / 18)                                                                     ← 18 h half-life
 *   affinity    = 1 + 1.2·follows + 0.5·ln(1 + interactions with the author in 30 d) + 0.3·followed by people you follow
 *   interest    = 1 + 0.9·min(1, Σ tag weights)  ← interests you picked at sign-up (0.6 each) + tags you like/reply/post (14-day decay)
 *   trust       = age × reach × spam, floor 0.2   ← account < 1 day 0.5, < 7 days 0.8; 0 followers 0.85;
 *                 2+ links 0.6, shouting (mostly caps) 0.7, marked 'not interested' by 3+ people 0.6
 *   media       = 1.1 with an image or media card;  notInterested = 0.6 ^ (times you hid this author)
 *
 * Then a greedy re-rank over the top 60: the k-th drop from one author is multiplied by 0.55^k, the same author never
 * appears twice in a row (unless nothing else is left), and every 5th slot goes to a discovery drop from someone outside
 * your circle (not followed, not followed by your follows, no past interaction). Each drop appears once.
 * Every item carries a short `why` ("you follow @x", "you're into #maps", …) for the "why am I seeing this" line.
 * The Following tab stays strictly chronological (followingPage).
 *
 * Pages are cut from a ranking snapshot (cursor = snapshot time + offset), so scrolling is stable while new drops arrive.
 */
import { Lru } from './lru'
import { all, one } from './db'

const H = 3600_000
const WINDOW = 7 * 24 * H
const HALF_LIFE_H = 18
const TAG_HALF_LIFE = 14 * 24 * H
const CHOSEN_INTEREST = 0.6
export const DISCOVERY_EVERY = 5

export type FeedItem = { id: string; passedBy?: { handle: string; at: number }; why?: string }

export type Cand = {
  id: string; author_id: number; created_at: number; like_count: number; reply_count: number; pass_count: number
  quote_count: number; bookmark_count: number; tip_total: number; vote_count: number; has_media: number
  author_handle?: string; author_created?: number; followers?: number; text?: string; ni_count?: number
}

export type Signals = {
  follows: Set<number>; fof: Set<number>; interact: Map<number, number>; tags: Map<string, number>; notInterestedAuthors: Map<number, number>
  chosen: Set<string>
}

export const emptySignals = (): Signals => ({ follows: new Set(), fof: new Set(), interact: new Map(), tags: new Map(), notInterestedAuthors: new Map(), chosen: new Set() })

export async function viewerSignals(viewer: number | null, now: number): Promise<Signals> {
  const s = emptySignals()
  if (!viewer) return s
  for (const r of await all<{ id: number }>('SELECT followee_id AS id FROM follows WHERE follower_id = ?', [viewer])) s.follows.add(Number(r.id))
  for (const r of await all<{ id: number }>(
    'SELECT DISTINCT f2.followee_id AS id FROM follows f1 JOIN follows f2 ON f2.follower_id = f1.followee_id WHERE f1.follower_id = ?', [viewer]))
    if (!s.follows.has(Number(r.id)) && Number(r.id) !== viewer) s.fof.add(Number(r.id))
  const since = now - 30 * 24 * H
  for (const r of await all<{ a: number; w: number }>(`
    SELECT a, SUM(w) AS w FROM (
      SELECT d.author_id AS a, 1.0 AS w FROM likes l JOIN drops d ON d.id = l.drop_id WHERE l.user_id = ? AND l.created_at > ?
      UNION ALL SELECT p.author_id, 2.0 FROM drops r JOIN drops p ON p.id = r.reply_to WHERE r.author_id = ? AND r.created_at > ?
      UNION ALL SELECT d.author_id, 2.0 FROM passes x JOIN drops d ON d.id = x.drop_id WHERE x.user_id = ? AND x.created_at > ?
    ) GROUP BY a`, [viewer, since, viewer, since, viewer, since]))
    if (Number(r.a) !== viewer) s.interact.set(Number(r.a), Number(r.w))
  // Tag interest learned from what you like (1), reply to (1.5) and post (0.5), decayed with a 14-day half-life.
  const raw = await all<{ tag: string; at: number; w: number }>(`
    SELECT t.tag, l.created_at AS at, 1.0 AS w FROM likes l JOIN tags t ON t.drop_id = l.drop_id WHERE l.user_id = ?
    UNION ALL SELECT t.tag, r.created_at, 1.5 FROM drops r JOIN tags t ON t.drop_id = r.reply_to WHERE r.author_id = ?
    UNION ALL SELECT t.tag, d.created_at, 0.5 FROM drops d JOIN tags t ON t.drop_id = d.id WHERE d.author_id = ?`, [viewer, viewer, viewer])
  let max = 0
  for (const r of raw) {
    const v = (s.tags.get(r.tag) ?? 0) + Number(r.w) * Math.pow(0.5, Math.max(0, now - Number(r.at)) / TAG_HALF_LIFE)
    s.tags.set(r.tag, v); max = Math.max(max, v)
  }
  if (max > 0) for (const [k, v] of s.tags) s.tags.set(k, v / max)
  // Interests picked at sign-up count from day one.
  const u = await one<{ i: string | null }>(`SELECT json_extract(extras, '$.interests') AS i FROM users WHERE id = ?`, [viewer])
  try { for (const t of (JSON.parse(u?.i ?? '[]') as string[])) { const k = String(t).toLowerCase(); s.chosen.add(k); s.tags.set(k, Math.max(s.tags.get(k) ?? 0, CHOSEN_INTEREST)) } } catch { /* bad json: ignore */ }
  for (const r of await all<{ a: number; n: number }>(
    'SELECT d.author_id AS a, COUNT(*) AS n FROM not_interested x JOIN drops d ON d.id = x.drop_id WHERE x.user_id = ? GROUP BY d.author_id', [viewer]))
    s.notInterestedAuthors.set(Number(r.a), Number(r.n))
  return s
}

type Eng = Pick<Cand, 'like_count' | 'reply_count' | 'pass_count' | 'quote_count' | 'bookmark_count' | 'tip_total' | 'vote_count'>
export function engagement(c: Eng) {
  return Math.log1p(Number(c.like_count) + 2 * Number(c.reply_count) + 2.5 * Number(c.pass_count) + 2.5 * Number(c.quote_count) + 1.5 * Number(c.bookmark_count))
    + 1.5 * Math.log1p(Number(c.tip_total) / 10) + 1.5 * Math.log1p(Number(c.vote_count) / 10)
}
export function velocity(c: Eng, ageH: number) {
  const raw = Number(c.like_count) + 2 * Number(c.reply_count) + 3 * Math.log1p(Number(c.tip_total) / 10)
  return 1 + 0.4 * Math.min(2.5, Math.log1p(raw / Math.max(1, ageH)))
}
const LINKS = /https?:\/\/|\bwww\./gi
export function trust(c: Pick<Cand, 'author_created' | 'followers' | 'text' | 'ni_count'>, now: number) {
  let t = 1
  if (c.author_created !== undefined) {
    const age = now - Number(c.author_created)
    if (age < 24 * H) t *= 0.5; else if (age < 7 * 24 * H) t *= 0.8
  }
  if (c.followers !== undefined && Number(c.followers) === 0) t *= 0.85
  const text = c.text ?? ''
  if ((text.match(LINKS) ?? []).length >= 2) t *= 0.6
  const letters = text.replace(/[^A-Za-z]/g, '')
  if (letters.length >= 20 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) t *= 0.7
  if (Number(c.ni_count ?? 0) >= 3) t *= 0.6
  return Math.max(0.2, t)
}

export type Parts = { engagement: number; velocity: number; recency: number; affinity: number; interest: number; trust: number; media: number; ni: number; topTag?: string }

export function scoreParts(c: Cand, tags: string[], s: Signals, viewer: number | null, now: number, passer?: number): Parts {
  const ageH = Math.max(0, now - Number(c.created_at)) / H
  const a = Number(c.author_id)
  let affinity = 1 + (s.follows.has(a) ? 1.2 : 0) + 0.5 * Math.log1p(s.interact.get(a) ?? 0) + (s.fof.has(a) ? 0.3 : 0)
  if (passer !== undefined) affinity = Math.max(affinity, 1.8 + 0.5 * Math.log1p(s.interact.get(passer) ?? 0))
  if (viewer === a) affinity = 0.8 // your own drops (fresh ones are pinned above the ranking, see rankForYou)
  let topTag: string | undefined, topW = 0
  for (const g of tags) { const w = s.tags.get(g) ?? 0; if (w > topW) { topW = w; topTag = g } }
  return {
    engagement: engagement(c), velocity: velocity(c, ageH), recency: Math.pow(0.5, ageH / HALF_LIFE_H), affinity,
    interest: 1 + 0.9 * Math.min(1, tags.reduce((t, g) => t + (s.tags.get(g) ?? 0), 0)),
    trust: trust(c, now), media: c.has_media ? 1.1 : 1, ni: Math.pow(0.6, s.notInterestedAuthors.get(a) ?? 0), topTag,
  }
}
export const combine = (p: Parts) => (1 + p.engagement) * p.velocity * p.recency * p.affinity * p.interest * p.trust * p.media * p.ni
export function scoreDrop(c: Cand, tags: string[], s: Signals, viewer: number | null, now: number, passer?: number) {
  return combine(scoreParts(c, tags, s, viewer, now, passer))
}

/** One short, honest reason, picked from the strongest signal. */
export function whyLine(c: Cand, p: Parts, s: Signals, opts: { discovery?: boolean; passedBy?: string } = {}) {
  const a = Number(c.author_id), h = c.author_handle ? `@${c.author_handle}` : 'this creator'
  if (opts.passedBy) return `@${opts.passedBy}, who you follow, passed this on`
  if (s.follows.has(a)) return `you follow ${h}`
  if (opts.discovery) return 'someone new, outside your usual circle'
  if (p.topTag && s.chosen.has(p.topTag)) return `you picked #${p.topTag} as an interest`
  if (p.topTag && (s.tags.get(p.topTag) ?? 0) >= 0.3) return `you often like #${p.topTag}`
  if ((s.interact.get(a) ?? 0) >= 2) return `you often reply to or like ${h}`
  if (s.fof.has(a)) return `people you follow follow ${h}`
  if (p.velocity >= 1.35) return 'picking up fast right now'
  if (p.engagement >= 3) return 'popular this week'
  return 'new here'
}

type Scored = { item: FeedItem; author: number; score: number; discovery: boolean; cand: Cand; parts: Parts }

/** Greedy re-rank: author decay, no back-to-back author, a discovery pick every DISCOVERY_EVERY-th slot. Exported for tests. */
export function rerank(scored: Scored[], s: Signals, start: FeedItem[] = []): FeedItem[] {
  const out = [...start]
  const pool = [...scored].sort((a, b) => b.score - a.score)
  const seen = new Map<number, number>()
  let last = -1
  while (pool.length) {
    const wantDiscovery = s.follows.size > 0 && (out.length + 1) % DISCOVERY_EVERY === 0
    let bi = -1, bs = -1, fi = -1, fs = -1
    for (let i = 0; i < Math.min(pool.length, 60); i++) {
      const q = pool[i]
      const eff = q.score * Math.pow(0.55, seen.get(q.author) ?? 0)
      if (q.author !== last && (!wantDiscovery || q.discovery) && eff > bs) { bs = eff; bi = i }
      if (q.author !== last && eff > fs) { fs = eff; fi = i }
    }
    if (bi < 0) bi = fi >= 0 ? fi : 0 // no discovery candidate, or only the last author is left
    const [p] = pool.splice(bi, 1)
    seen.set(p.author, (seen.get(p.author) ?? 0) + 1)
    last = p.author
    const disc = wantDiscovery && p.discovery
    out.push({ ...p.item, why: whyLine(p.cand, p.parts, s, { discovery: disc, passedBy: p.item.passedBy?.handle }) })
  }
  return out
}

const rankCache = new Lru<string, { at: number; items: FeedItem[] }>({ max: 500, ttlMs: 120_000 })

export async function rankForYou(viewer: number | null, snapshot: number): Promise<FeedItem[]> {
  const key = `${viewer ?? 0}:${snapshot}`
  const hit = rankCache.get(key)
  if (hit && Date.now() - hit.at < 120_000) return hit.items
  const s = await viewerSignals(viewer, snapshot)
  const v = viewer ?? 0
  const hidden = `
    AND d.deleted = 0
    AND d.author_id NOT IN (SELECT target_id FROM mutes WHERE user_id = ${Number(v)})
    AND d.id NOT IN (SELECT drop_id FROM not_interested WHERE user_id = ${Number(v)})`
  const cols = `d.id, d.author_id, d.created_at, d.like_count, d.reply_count, d.pass_count, d.quote_count, d.bookmark_count, d.tip_total, d.vote_count,
    (d.image IS NOT NULL OR d.media IS NOT NULL) AS has_media, d.text,
    au.handle AS author_handle, au.created_at AS author_created,
    (SELECT COUNT(*) FROM follows fl WHERE fl.followee_id = d.author_id) AS followers,
    (SELECT COUNT(*) FROM not_interested nx WHERE nx.drop_id = d.id) AS ni_count`
  const cands = await all<Cand>(`SELECT ${cols} FROM drops d JOIN users au ON au.id = d.author_id
    WHERE d.reply_to IS NULL AND d.created_at <= ? AND d.created_at > ? ${hidden}
    ORDER BY d.created_at DESC LIMIT 800`, [snapshot, snapshot - WINDOW])
  // Passes by people you follow bring in drops from outside your circle.
  const passRows = s.follows.size ? await all<Cand & { passer: number; passer_handle: string; passed_at: number }>(
    `SELECT ${cols}, p.user_id AS passer, u.handle AS passer_handle, p.created_at AS passed_at FROM passes p
     JOIN drops d ON d.id = p.drop_id JOIN users u ON u.id = p.user_id JOIN users au ON au.id = d.author_id
     WHERE p.user_id IN (${[...s.follows].join(',')}) AND p.created_at <= ? AND p.created_at > ? AND d.reply_to IS NULL ${hidden}`,
    [snapshot, snapshot - WINDOW]) : []
  const ids = [...new Set([...cands.map(c => c.id), ...passRows.map(c => c.id)])]
  const tagMap = new Map<string, string[]>()
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400)
    if (!chunk.length) continue
    for (const t of await all<{ drop_id: string; tag: string }>(`SELECT drop_id, tag FROM tags WHERE drop_id IN (${chunk.map(() => '?').join(',')})`, chunk))
      tagMap.set(t.drop_id, [...(tagMap.get(t.drop_id) ?? []), t.tag])
  }
  const outside = (a: number) => !!viewer && a !== viewer && !s.follows.has(a) && !s.fof.has(a) && !s.interact.has(a)
  const best = new Map<string, Scored>()
  const consider = (x: Scored) => { const cur = best.get(x.item.id); if (!cur || x.score > cur.score) best.set(x.item.id, x) }
  for (const c of cands) {
    const parts = scoreParts(c, tagMap.get(c.id) ?? [], s, viewer, snapshot)
    consider({ item: { id: c.id }, author: Number(c.author_id), score: combine(parts), discovery: outside(Number(c.author_id)), cand: c, parts })
  }
  for (const c of passRows) {
    if (Number(c.author_id) === viewer) continue
    // A pass is as fresh as the moment it was passed on (but never fresher than half its original age).
    const fresh = { ...c, created_at: Math.max(Number(c.created_at), (Number(c.passed_at) + Number(c.created_at)) / 2) }
    const parts = scoreParts(fresh, tagMap.get(c.id) ?? [], s, viewer, snapshot, Number(c.passer))
    consider({ item: { id: c.id, passedBy: { handle: c.passer_handle, at: Number(c.passed_at) } }, author: Number(c.author_id), score: combine(parts), discovery: false, cand: c, parts })
  }
  // Your own drops from the last 15 minutes sit on top, newest first, like they just landed.
  const pinned: FeedItem[] = []
  for (const c of cands.filter(c => viewer && Number(c.author_id) === viewer && snapshot - Number(c.created_at) < 15 * 60_000)) {
    pinned.push({ id: c.id, why: 'you just posted this' }); best.delete(c.id)
  }
  const out = rerank([...best.values()], s, pinned)
  rankCache.set(key, { at: Date.now(), items: out })
  return out
}

export function clearRankCache() { rankCache.clear() }

export async function followingPage(viewer: number, cursor: { ts: number; id: string } | null, limit: number) {
  const c = cursor ?? { ts: Number.MAX_SAFE_INTEGER, id: '\uffff' }
  const rows = await all<{ drop_id: string; ts: number; passer: string | null }>(`
    SELECT * FROM (
      SELECT d.id AS drop_id, d.created_at AS ts, NULL AS passer FROM drops d
        WHERE (d.author_id = ?1 OR d.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?1))
          AND d.reply_to IS NULL AND d.deleted = 0
      UNION ALL
      SELECT p.drop_id, p.created_at, u.handle FROM passes p JOIN users u ON u.id = p.user_id JOIN drops d ON d.id = p.drop_id
        WHERE p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?1) AND d.deleted = 0 AND d.author_id <> ?1
    ) x
    WHERE (x.ts < ?2 OR (x.ts = ?2 AND x.drop_id < ?3))
      AND x.drop_id NOT IN (SELECT drop_id FROM not_interested WHERE user_id = ?1)
      AND (SELECT author_id FROM drops WHERE id = x.drop_id) NOT IN (SELECT target_id FROM mutes WHERE user_id = ?1)
    ORDER BY x.ts DESC, x.drop_id DESC LIMIT ?4`, [viewer, c.ts, c.id, limit + 1])
  const more = rows.length > limit
  const page = rows.slice(0, limit)
  const items: FeedItem[] = []
  const seen = new Set<string>()
  for (const r of page) {
    if (seen.has(r.drop_id)) continue
    seen.add(r.drop_id)
    items.push({ id: r.drop_id, passedBy: r.passer ? { handle: r.passer, at: Number(r.ts) } : undefined })
  }
  const last = page[page.length - 1]
  return { items, next: more && last ? { ts: Number(last.ts), id: last.drop_id } : null }
}

/** How many drops arrived since the feed was loaded, plus up to three of their authors for the "new drops" pill. */
export async function newSince(viewer: number | null, tab: string, since: number) {
  const scope = tab === 'following' && viewer
    ? { sql: 'AND d.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)', args: [viewer] }
    : { sql: 'AND d.author_id <> ? AND d.author_id NOT IN (SELECT target_id FROM mutes WHERE user_id = ?)', args: [viewer ?? 0, viewer ?? 0] }
  const where = `FROM drops d JOIN users u ON u.id = d.author_id WHERE d.created_at > ? AND d.reply_to IS NULL AND d.deleted = 0 ${scope.sql}`
  const n = await all<{ n: number }>(`SELECT COUNT(*) AS n ${where}`, [since, ...scope.args])
  const a = await all<{ handle: string }>(`SELECT u.handle, MAX(d.created_at) AS t ${where} GROUP BY u.handle ORDER BY t DESC LIMIT 3`, [since, ...scope.args])
  return { count: Number(n[0]?.n ?? 0), authors: a.map(r => String(r.handle)) }
}
