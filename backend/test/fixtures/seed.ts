/** Test fixtures only (seed = 1 rows for the api tests). Not shipped: the server never seeds. */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { UPLOAD_DIR, demoSeedAllowed } from '../../src/config'
import { all, run } from '../../src/db'
import { FILLER, REPLY_POOL, SEED_DROPS, SEED_NAMES, SEED_USERS } from './seed-data'
import { extractTags, newId } from '../../src/util'
export { purgeSeed } from '../../src/purge-seed'

const SEED_ASSETS = resolve(import.meta.dirname, 'seed-assets')

const H = 3600_000

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}


export async function seed(opts: { now?: number; quiet?: boolean } = {}) {
  if (!demoSeedAllowed()) throw new Error('refusing to seed demo data in production (NODE_ENV=production). ALLOW_DEMO_SEED=1 overrides, for a throwaway database only')
  const now = opts.now ?? Date.now()
  const r = rng(20261024)
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]
  // Copy seed images into uploads/ so they are served like any upload.
  mkdirSync(UPLOAD_DIR, { recursive: true })
  if (existsSync(SEED_ASSETS)) for (const f of readdirSync(SEED_ASSETS)) copyFileSync(resolve(SEED_ASSETS, f), resolve(UPLOAD_DIR, f))
  const img = (f?: string) => (f && existsSync(resolve(UPLOAD_DIR, f)) ? `/uploads/${f}` : null)

  const uid = new Map<string, number>()
  for (const [i, u] of SEED_USERS.entries()) {
    const res = await run(`INSERT INTO users (handle, name, bio, avatar, location, tone, plus, creator, extras, onboarded, seed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
      [u.handle, u.name, u.bio, img(u.avatar), u.location ?? null, u.tone, u.plus ? 1 : 0, u.creator ? 1 : 0, JSON.stringify(u.extras ?? {}), now - (60 - i) * 24 * H])
    uid.set(u.handle, Number(res.lastInsertRowid))
  }
  // .wif names: your @username is your primary .wif, so every demo user holds handle.wif as primary, with
  // text records (avatar, bio). Plus a few demo extras, some listed. Demo rows are seed = 1: nothing here is a
  // transaction, no tx hash is ever seeded, and no wallet address is invented (demo names resolve to no wallet).
  for (const [i, u] of SEED_USERS.entries()) {
    const id = uid.get(u.handle)!
    await run('INSERT OR IGNORE INTO names (name, owner_id, seed, created_at) VALUES (?, ?, 1, ?)', [u.handle, id, now - (30 + i) * 24 * H])
    await run(`UPDATE users SET extras = json_set(extras, '$.wifName', ?) WHERE id = ?`, [u.handle, id])
    await run('INSERT OR REPLACE INTO name_records (name, avatar, bio, updated_at) VALUES (?, ?, ?, ?)', [u.handle, img(u.avatar), u.bio.slice(0, 160), now - i * H])
  }
  for (const n of SEED_NAMES) {
    const owner = uid.get(n.owner); if (!owner) continue
    await run('INSERT OR IGNORE INTO names (name, owner_id, seed, created_at) VALUES (?, ?, 1, ?)', [n.name, owner, now - n.daysAgo * 24 * H])
    if (n.price) await run('INSERT OR IGNORE INTO name_listings (name, seller_id, price, seed, created_at) VALUES (?, ?, ?, 1, ?)', [n.name, owner, n.price, now - n.daysAgo * 12 * H])
  }
  // Demo badge progress (cumulative WIF burned) so badge shelves aren't empty. Shown as demo numbers, never as transactions.
  for (const [h, b] of [['noravale', 64200], ['junoflat', 12800], ['hanadraws', 268000], ['meridian', 3100], ['atlasclub', 1040000]] as const)
    if (uid.has(h)) await run(`UPDATE users SET extras = json_set(extras, '$.demoBurned', ?) WHERE id = ?`, [b, uid.get(h)!])
  const byHandle = new Map(SEED_USERS.map(u => [u.handle, u]))
  const overlap = (a: string[], b: string[]) => a.filter(x => b.includes(x)).length

  // Follow graph: shared interests and popularity.
  const follows = new Set<string>()
  for (const a of SEED_USERS) for (const b of SEED_USERS) {
    if (a === b) continue
    const p = Math.min(0.9, 0.08 + 0.3 * Math.min(1, overlap(a.interests, b.interests)) + 0.35 * b.pop)
    if (r() < p) follows.add(`${a.handle}>${b.handle}`)
  }
  for (const f of follows) {
    const [a, b] = f.split('>')
    await run('INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)', [uid.get(a)!, uid.get(b)!, now - Math.floor(r() * 50) * 24 * H])
  }

  type Made = { id: string; author: string; at: number; tags: string[] }
  const made: Made[] = []
  const insertDrop = async (d: { id?: string; author: string; text: string; at: number; image?: string | null; media?: unknown; locked?: unknown; supportersOnly?: string; replyTo?: Made; quoteOf?: string; base?: { likes?: number; passes?: number; tipped?: number; votes?: number } }) => {
    const id = d.id ?? newId()
    await run(`INSERT INTO drops (id, author_id, text, image, media, locked, supporters_only, reply_to, root_id, quote_of, like_count, pass_count, tip_total, vote_count, seed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, uid.get(d.author)!, d.text, d.image ?? null, d.media ? JSON.stringify(d.media) : null, d.locked ? JSON.stringify(d.locked) : null, d.supportersOnly ?? null,
        d.replyTo?.id ?? null, d.replyTo?.id ?? null, d.quoteOf ?? null, d.base?.likes ?? 0, d.base?.passes ?? 0, d.base?.tipped ?? 0, d.base?.votes ?? 0, d.at])
    const tags = extractTags(d.text)
    for (const t of tags) await run('INSERT OR IGNORE INTO tags (drop_id, tag, created_at) VALUES (?, ?, ?)', [id, t, d.at])
    if (d.replyTo) await run('UPDATE drops SET reply_count = reply_count + 1 WHERE id = ?', [d.replyTo.id])
    if (d.quoteOf) await run('UPDATE drops SET quote_count = quote_count + 1 WHERE id = ?', [d.quoteOf])
    const m = { id, author: d.author, at: d.at, tags }
    return m
  }

  for (const sd of SEED_DROPS) {
    const at = now - Math.round(sd.hoursAgo * H)
    const top = await insertDrop({ id: sd.id, author: sd.author, text: sd.text, at, image: img(sd.image), media: sd.media, locked: sd.locked, supportersOnly: sd.supportersOnly, base: sd.base })
    made.push(top)
    let t = at
    let prev = top
    for (const [author, text] of sd.replies ?? []) {
      t = Math.min(now - 30_000, t + Math.round((0.02 + r() * 0.3) * H))
      // "@x" replies continue the thread under the previous reply, others reply to the drop.
      const parent = text.startsWith('@') ? prev : top
      prev = await insertDrop({ author, text, at: t, replyTo: parent })
    }
    // A few extra short replies from people who care about the topic.
    if (!sd.replies) {
      const n = Math.floor(r() * 3)
      for (let i = 0; i < n; i++) {
        const fans = SEED_USERS.filter(u => u.handle !== sd.author && overlap(u.interests, top.tags) > 0)
        if (!fans.length) break
        const tag = top.tags.find(x => REPLY_POOL[x]) ?? '_'
        t = Math.min(now - 30_000, t + Math.round((0.05 + r() * 1.5) * H))
        await insertDrop({ author: pick(fans).handle, text: pick(r() < 0.6 ? REPLY_POOL[tag] : REPLY_POOL._), at: t, replyTo: top })
      }
    }
  }

  // Filler: everyday drops so scrolling has depth. Spread over the last 6.5 days.
  const usedFiller = new Set<string>()
  for (const u of SEED_USERS) {
    const n = 2 + Math.floor(r() * 3)
    for (let i = 0; i < n; i++) {
      const pool = u.interests.flatMap(t => FILLER[t] ?? []).filter(t => !usedFiller.has(t))
      if (!pool.length) break
      const text = pick(pool); usedFiller.add(text)
      const hours = 0.2 + r() * 156
      const scale = 0.3 + u.pop * 2
      made.push(await insertDrop({ author: u.handle, text, at: now - Math.round(hours * H),
        base: { likes: Math.round(r() * 120 * scale), passes: Math.round(r() * 15 * scale), tipped: Math.round(r() * 400 * scale), votes: Math.round(r() * 60 * scale) } }))
    }
  }
  // Quotes.
  const textOf = async (prefix: string) => (await all<{ id: string }>('SELECT id FROM drops WHERE text LIKE ? AND reply_to IS NULL LIMIT 1', [`${prefix}%`]))[0]?.id
  const q1 = await textOf('Sent $200 from Johannesburg')
  if (q1) made.push(await insertDrop({ author: 'meridian', text: 'The most important chart nobody makes. Read Sipho\'s numbers, then tell me fees are a detail. #fairfinance', at: now - 4.5 * H, quoteOf: q1, base: { likes: 180, passes: 30, tipped: 400, votes: 90 } }))
  const q2 = await textOf('Borderless series #12')
  if (q2) made.push(await insertDrop({ author: 'atlasclub', text: 'This week\'s map challenge: draw your own region with no borders. Best one gets a Top Spot shout. #cartography #flatmap', at: now - 1.2 * H, quoteOf: q2, base: { likes: 90, passes: 20, tipped: 100, votes: 60 } }))

  // Likes, passes, bookmarks from seed users, shaped by interests and follows.
  const tops = await all<{ id: string; author_id: number; created_at: number; reply_to: string | null }>('SELECT id, author_id, created_at, reply_to FROM drops WHERE seed = 1')
  const handleOf = new Map([...uid.entries()].map(([h, i]) => [i, h]))
  const tagRows = await all<{ drop_id: string; tag: string }>('SELECT drop_id, tag FROM tags')
  const tagsOf = new Map<string, string[]>()
  for (const t of tagRows) tagsOf.set(t.drop_id, [...(tagsOf.get(t.drop_id) ?? []), t.tag])
  for (const d of tops) {
    const author = handleOf.get(Number(d.author_id))!
    for (const u of SEED_USERS) {
      if (u.handle === author) continue
      const tl = tagsOf.get(d.id) ?? []
      const fol = follows.has(`${u.handle}>${author}`)
      const p = (d.reply_to ? 0.25 : 1) * (0.04 + 0.35 * Math.min(1, overlap(u.interests, tl)) + (fol ? 0.2 : 0) + 0.1 * byHandle.get(author)!.pop)
      if (r() >= p) continue
      const at = Math.min(now - 1000, Number(d.created_at) + Math.round(r() * Math.max(60_000, now - Number(d.created_at)) * 0.6))
      await run('INSERT INTO likes (user_id, drop_id, created_at) VALUES (?, ?, ?)', [uid.get(u.handle)!, d.id, at])
      await run('UPDATE drops SET like_count = like_count + 1 WHERE id = ?', [d.id])
      if (!d.reply_to && r() < 0.18) {
        await run('INSERT INTO passes (user_id, drop_id, created_at) VALUES (?, ?, ?)', [uid.get(u.handle)!, d.id, at + 60_000])
        await run('UPDATE drops SET pass_count = pass_count + 1 WHERE id = ?', [d.id])
      }
      if (r() < 0.06) {
        await run('INSERT INTO bookmarks (user_id, drop_id, created_at) VALUES (?, ?, ?)', [uid.get(u.handle)!, d.id, at])
        await run('UPDATE drops SET bookmark_count = bookmark_count + 1 WHERE id = ?', [d.id])
      }
    }
  }
  if (!opts.quiet) {
    const c = await all<{ t: string; n: number }>(`SELECT 'users' t, COUNT(*) n FROM users UNION ALL SELECT 'drops', COUNT(*) FROM drops UNION ALL SELECT 'likes', COUNT(*) FROM likes UNION ALL SELECT 'follows', COUNT(*) FROM follows`)
    console.log('seeded (demo data):', Object.fromEntries(c.map(x => [x.t, Number(x.n)])))
  }
}
