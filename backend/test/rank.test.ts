/** Ranking unit tests: pure functions only (no database). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { combine, emptySignals, rerank, scoreParts, trust, velocity, whyLine, DISCOVERY_EVERY, type Cand } from '../src/rank'

const H = 3600_000, NOW = 1_800_000_000_000
const OLD = NOW - 90 * 24 * H
let n = 0
const cand = (o: Partial<Cand> = {}): Cand => ({
  id: `d${++n}`, author_id: 1, created_at: NOW - 2 * H, like_count: 0, reply_count: 0, pass_count: 0, quote_count: 0, bookmark_count: 0,
  tip_total: 0, vote_count: 0, has_media: 0, author_handle: 'a', author_created: OLD, followers: 10, text: 'hello', ni_count: 0, ...o,
})
const score = (c: Cand, s = emptySignals(), tags: string[] = []) => combine(scoreParts(c, tags, s, 99, NOW))

test('recency decays with an 18 h half-life', () => {
  const fresh = score(cand({ created_at: NOW - 1 * H })), day = score(cand({ created_at: NOW - 19 * H }))
  assert.ok(Math.abs(day / fresh - 0.5) < 0.02, `${day / fresh}`)
})

test('engagement and velocity: the same likes count more when they came fast', () => {
  assert.ok(score(cand({ like_count: 20 })) > score(cand()))
  assert.ok(velocity({ like_count: 20, reply_count: 0, pass_count: 0, quote_count: 0, bookmark_count: 0, tip_total: 0, vote_count: 0 }, 1)
    > velocity({ like_count: 20, reply_count: 0, pass_count: 0, quote_count: 0, bookmark_count: 0, tip_total: 0, vote_count: 0 }, 48))
  assert.ok(velocity({ like_count: 1e9, reply_count: 0, pass_count: 0, quote_count: 0, bookmark_count: 0, tip_total: 0, vote_count: 0 }, 1) <= 2, 'capped')
})

test('follows and chosen interests lift a drop', () => {
  const s = emptySignals(); s.follows.add(1)
  assert.ok(score(cand(), s) > score(cand()))
  const t = emptySignals(); t.chosen.add('maps'); t.tags.set('maps', 0.6)
  assert.ok(score(cand(), t, ['maps']) > score(cand(), t, ['food']))
})

test('trust: new accounts, zero followers and spammy text rank lower', () => {
  assert.equal(trust(cand(), NOW), 1)
  assert.equal(trust(cand({ author_created: NOW - 2 * H }), NOW), 0.5)
  assert.equal(trust(cand({ author_created: NOW - 3 * 24 * H }), NOW), 0.8)
  assert.equal(trust(cand({ followers: 0 }), NOW), 0.85)
  assert.equal(trust(cand({ text: 'buy https://a.xyz now https://b.xyz' }), NOW), 0.6)
  assert.equal(trust(cand({ text: 'FREE MONEY CLICK HERE RIGHT NOW FRIENDS' }), NOW), 0.7)
  assert.equal(trust(cand({ ni_count: 5 }), NOW), 0.6)
  assert.ok(trust(cand({ author_created: NOW, followers: 0, text: 'GO https://a.io https://b.io NOW NOW NOW NOW', ni_count: 9 }), NOW) >= 0.2, 'floor')
  assert.ok(score(cand({ author_created: NOW - H })) < score(cand()))
})

function scored(author: number, sc: number, discovery = false) {
  const c = cand({ author_id: author, author_handle: `u${author}` })
  return { item: { id: c.id }, author, score: sc, discovery, cand: c, parts: scoreParts(c, [], emptySignals(), 99, NOW) }
}

test('re-rank: never the same author back to back while others are left', () => {
  const s = emptySignals()
  const pool = [scored(1, 100), scored(1, 99), scored(1, 98), scored(2, 10), scored(3, 9)]
  const out = rerank(pool, s)
  const authors = out.map(i => pool.find(p => p.item.id === i.id)!.author)
  for (let i = 1; i < authors.length - 1; i++) assert.notEqual(authors[i], authors[i - 1], authors.join(','))
  assert.equal(out.length, 5)
})

test('re-rank: every 5th slot is a discovery pick with its reason', () => {
  const s = emptySignals(); s.follows.add(1); s.follows.add(2)
  const pool = [...Array.from({ length: 12 }, (_, i) => scored(1 + (i % 2), 100 - i)), scored(7, 1, true), scored(8, 0.5, true)]
  const out = rerank(pool, s)
  const at = out[DISCOVERY_EVERY - 1]
  assert.ok(pool.find(p => p.item.id === at.id)!.discovery)
  assert.equal(at.why, 'someone new, outside your usual circle')
  assert.equal(new Set(out.map(i => i.id)).size, out.length, 'no repeats')
})

test('why line picks the strongest honest reason', () => {
  const s = emptySignals(); s.follows.add(1); s.chosen.add('maps'); s.tags.set('maps', 0.6)
  const c = cand(), p = scoreParts(c, ['maps'], s, 99, NOW)
  assert.equal(whyLine(c, p, s), 'you follow @a')
  const c2 = cand({ author_id: 5 }), p2 = scoreParts(c2, ['maps'], s, 99, NOW)
  assert.equal(whyLine(c2, p2, s), 'you picked #maps as an interest')
  assert.equal(whyLine(c2, p2, s, { passedBy: 'zed' }), '@zed, who you follow, passed this on')
  const e = emptySignals(), c3 = cand({ author_id: 6, like_count: 40, created_at: NOW - H })
  assert.equal(whyLine(c3, scoreParts(c3, [], e, 99, NOW), e), 'picking up fast right now')
  const c4 = cand({ author_id: 6 })
  assert.equal(whyLine(c4, scoreParts(c4, [], e, 99, NOW), e), 'new here')
})
