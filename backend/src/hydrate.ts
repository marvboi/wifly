import { BADGE_TIERS, PLUS_GRACE_MS } from './config'
import { all } from './db'

export type UserRow = {
  id: number; address: string | null; handle: string; name: string; bio: string; avatar: string | null
  location: string | null; tone: number; plus: number; creator: number; extras: string; onboarded: number; seed: number; created_at: number
}
export type DropRow = {
  id: string; author_id: number; text: string; image: string | null; media: string | null; locked: string | null
  supporters_only: string | null; reply_to: string | null; root_id: string | null; quote_of: string | null
  like_count: number; reply_count: number; pass_count: number; quote_count: number; bookmark_count: number
  tip_total: number; vote_count: number; deleted: number; seed: number; created_at: number
}

export type ApiUser = {
  handle: string; name: string; bio: string; avatar: string | null; location: string | null; tone: number
  plus: boolean; plusGrace?: boolean; badge?: string | null; creator: boolean; joined: number; address: string | null; wifName?: string | null
  followers: number; following: number; drops: number
  youFollow: boolean; followsYou: boolean; you: boolean; muted: boolean
  supporters?: number; dmPrice?: number; tiers?: unknown; shop?: unknown; seed: boolean
}
export type ApiDrop = {
  id: string; author: ApiUser; text: string; lockedHidden?: boolean; unlocked?: boolean; image: string | null; media: unknown; locked: unknown; supportersOnly: string | null
  replyTo: string | null; replyToHandle: string | null; rootId: string | null; quote: ApiDrop | null; quoteMissing: boolean
  createdAt: number; likes: number; replies: number; passes: number; quotes: number; tipped: number; votes: number
  liked: boolean; passed: boolean; bookmarked: boolean; mine: boolean; deleted: boolean; tags: string[]
  passedBy?: string; passedAt?: number; seed: boolean
}

const qs = (n: number) => Array(n).fill('?').join(',')
const parse = (s: string | null) => { if (!s) return null; try { return JSON.parse(s) } catch { return null } }

export async function hydrateUsers(ids: number[], viewer: number | null): Promise<Map<number, ApiUser>> {
  const uniq = [...new Set(ids)]
  const out = new Map<number, ApiUser>()
  if (!uniq.length) return out
  const rows = await all<UserRow & { followers: number; following: number; drops: number }>(
    `SELECT u.*,
      (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS followers,
      (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS following,
      (SELECT COUNT(*) FROM drops d WHERE d.author_id = u.id AND d.deleted = 0 AND d.reply_to IS NULL) AS drops
     FROM users u WHERE u.id IN (${qs(uniq.length)})`, uniq)
  // Plus comes only from the tracked expiry (active, or inside the 5-day grace).
  const subs = new Map((await all<{ user_id: number; expires_at: number }>(`SELECT user_id, expires_at FROM plus_subs WHERE user_id IN (${qs(uniq.length)})`, uniq)).map(r => [Number(r.user_id), Number(r.expires_at)]))
  const burns = new Map((await all<{ user_id: number; s: number }>(`SELECT user_id, SUM(amount) AS s FROM badge_burns WHERE verified = 1 AND user_id IN (${qs(uniq.length)}) GROUP BY user_id`, uniq)).map(r => [Number(r.user_id), Number(r.s)]))
  // Primary .wif name (reverseName): only while the user still holds it.
  const held = new Set((await all<{ name: string; owner_id: number }>(`SELECT name, owner_id FROM names WHERE owner_id IN (${qs(uniq.length)})`, uniq)).map(r => `${Number(r.owner_id)}:${String(r.name).toLowerCase()}`))
  const t = Date.now()
  const fol = new Set<number>(), fby = new Set<number>(), mut = new Set<number>()
  if (viewer) {
    for (const r of await all<{ followee_id: number }>(`SELECT followee_id FROM follows WHERE follower_id = ? AND followee_id IN (${qs(uniq.length)})`, [viewer, ...uniq])) fol.add(Number(r.followee_id))
    for (const r of await all<{ follower_id: number }>(`SELECT follower_id FROM follows WHERE followee_id = ? AND follower_id IN (${qs(uniq.length)})`, [viewer, ...uniq])) fby.add(Number(r.follower_id))
    for (const r of await all<{ target_id: number }>(`SELECT target_id FROM mutes WHERE user_id = ? AND target_id IN (${qs(uniq.length)})`, [viewer, ...uniq])) mut.add(Number(r.target_id))
  }
  for (const r of rows) {
    const id = Number(r.id)
    const x = parse(r.extras) ?? {}
    const exp = subs.get(id) ?? 0
    const plus = exp ? t < exp + PLUS_GRACE_MS : false
    // Badges count verified burns only.
    const burned = burns.get(id) ?? 0
    const badge = [...BADGE_TIERS].reverse().find(b => burned >= b.min)?.id ?? null
    out.set(id, {
      handle: r.handle, name: displayName(r.name, r.handle), bio: r.bio, avatar: r.avatar, location: r.location, tone: Number(r.tone),
      plus, plusGrace: !!exp && t >= exp && t < exp + PLUS_GRACE_MS, badge, creator: !!r.creator, joined: Number(r.created_at), address: r.address,
      wifName: x.wifName && held.has(`${id}:${String(x.wifName).toLowerCase()}`) ? String(x.wifName).toLowerCase() : null,
      // Real counts only.
      followers: Number(r.followers), following: Number(r.following), drops: Number(r.drops),
      youFollow: fol.has(id), followsYou: fby.has(id), you: viewer === id, muted: mut.has(id),
      supporters: x.supporters, dmPrice: x.dmPrice, tiers: x.tiers, shop: x.shop, seed: !!r.seed,
    })
  }
  return out
}

/** Turn drop ids into API drops for a viewer, keeping order. Quotes are expanded one level. */
export async function hydrateDrops(ids: string[], viewer: number | null, opts: { passedBy?: Map<string, { handle: string; at: number }> } = {}): Promise<ApiDrop[]> {
  if (!ids.length) return []
  const uniq = [...new Set(ids)]
  const rows = await all<DropRow>(`SELECT * FROM drops WHERE id IN (${qs(uniq.length)})`, uniq)
  const byId = new Map(rows.map(r => [r.id, r]))
  const quoteIds = rows.map(r => r.quote_of).filter((x): x is string => !!x && !byId.has(x))
  const parentIds = rows.map(r => r.reply_to).filter((x): x is string => !!x && !byId.has(x))
  const extra = quoteIds.length + parentIds.length
    ? await all<DropRow>(`SELECT * FROM drops WHERE id IN (${qs(quoteIds.length + parentIds.length)})`, [...quoteIds, ...parentIds]) : []
  for (const r of extra) byId.set(r.id, r)
  const all_ = [...byId.values()]
  const users = await hydrateUsers(all_.map(r => Number(r.author_id)), viewer)
  const tagRows = await all<{ drop_id: string; tag: string }>(`SELECT drop_id, tag FROM tags WHERE drop_id IN (${qs(all_.length)})`, all_.map(r => r.id))
  const tagMap = new Map<string, string[]>()
  for (const t of tagRows) tagMap.set(t.drop_id, [...(tagMap.get(t.drop_id) ?? []), t.tag])
  const liked = new Set<string>(), passed = new Set<string>(), marked = new Set<string>()
  if (viewer) {
    const ph = qs(all_.length), a = [viewer, ...all_.map(r => r.id)]
    for (const r of await all<{ drop_id: string }>(`SELECT drop_id FROM likes WHERE user_id = ? AND drop_id IN (${ph})`, a)) liked.add(r.drop_id)
    for (const r of await all<{ drop_id: string }>(`SELECT drop_id FROM passes WHERE user_id = ? AND drop_id IN (${ph})`, a)) passed.add(r.drop_id)
    for (const r of await all<{ drop_id: string }>(`SELECT drop_id FROM bookmarks WHERE user_id = ? AND drop_id IN (${ph})`, a)) marked.add(r.drop_id)
  }
  const unlocked = new Set<string>()
  if (viewer) for (const r of await all<{ drop_id: string }>(`SELECT drop_id FROM unlocks WHERE user_id = ? AND drop_id IN (${qs(all_.length)})`, [viewer, ...all_.map(r => r.id)])) unlocked.add(r.drop_id)
  const build = (r: DropRow, depth: number): ApiDrop => {
    const dead = !!r.deleted
    const q = r.quote_of ? byId.get(r.quote_of) : undefined
    const parent = r.reply_to ? byId.get(r.reply_to) : undefined
    const pb = opts.passedBy?.get(r.id)
    // Paid drops: the text only leaves the server for the author or someone who unlocked it.
    const gated = (!!r.locked || !!r.supporters_only) && viewer !== Number(r.author_id) && !unlocked.has(r.id)
    return {
      id: r.id, author: users.get(Number(r.author_id))!, text: dead || gated ? '' : r.text, image: dead || gated ? null : r.image,
      lockedHidden: gated, unlocked: unlocked.has(r.id),
      media: dead || gated ? null : parse(r.media), locked: dead ? null : parse(r.locked), supportersOnly: r.supporters_only,
      replyTo: r.reply_to, replyToHandle: parent ? users.get(Number(parent.author_id))?.handle ?? null : null, rootId: r.root_id,
      quote: q && depth === 0 && !q.deleted ? build(q, 1) : null, quoteMissing: !!r.quote_of && (!q || !!q.deleted),
      createdAt: Number(r.created_at), likes: Number(r.like_count), replies: Number(r.reply_count), passes: Number(r.pass_count),
      quotes: Number(r.quote_count), tipped: Number(r.tip_total), votes: Number(r.vote_count),
      liked: liked.has(r.id), passed: passed.has(r.id), bookmarked: marked.has(r.id), mine: viewer === Number(r.author_id),
      deleted: dead, tags: tagMap.get(r.id) ?? [], passedBy: pb?.handle, passedAt: pb?.at, seed: !!r.seed,
    }
  }
  return ids.map(id => byId.get(id)).filter((r): r is DropRow => !!r).map(r => build(r, 0))
}

/** Shown name: the one they picked, else the @username. Older accounts carry the old "new on wifly" placeholder. */
export function displayName(name: string | null | undefined, handle: string) {
  const n = (name ?? '').trim()
  return !n || /^new on wifly$/i.test(n) ? handle : n
}
