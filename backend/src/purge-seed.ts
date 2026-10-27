/**
 * Removes old demo rows (seed = 1) and keeps real users and their drops. The server never seeds.
 *   npx tsx src/purge-seed.ts
 */
import { db, migrate, run } from './db'

export async function purgeSeed() {
  const ids = `(SELECT id FROM drops WHERE seed = 1)`
  for (const t of ['likes', 'passes', 'bookmarks', 'not_interested', 'tags']) await run(`DELETE FROM ${t} WHERE drop_id IN ${ids}`)
  await run(`DELETE FROM notifications WHERE drop_id IN ${ids} OR actor_id IN (SELECT id FROM users WHERE seed = 1) OR user_id IN (SELECT id FROM users WHERE seed = 1)`)
  // Real drops that replied to / quoted seed drops lose the link but stay.
  await run(`UPDATE drops SET reply_to = NULL, root_id = NULL WHERE seed = 0 AND reply_to IN ${ids}`)
  await run(`UPDATE drops SET quote_of = NULL WHERE seed = 0 AND quote_of IN ${ids}`)
  await run(`DELETE FROM drops WHERE seed = 1`)
  const uids = `(SELECT id FROM users WHERE seed = 1)`
  for (const [t, a, b] of [['likes', 'user_id', ''], ['passes', 'user_id', ''], ['bookmarks', 'user_id', ''], ['follows', 'follower_id', 'followee_id'], ['mutes', 'user_id', 'target_id']] as const)
    await run(`DELETE FROM ${t} WHERE ${a} IN ${uids}${b ? ` OR ${b} IN ${uids}` : ''}`)
  await run(`DELETE FROM name_listings WHERE seed = 1 OR seller_id IN ${uids}`)
  await run(`DELETE FROM name_offers WHERE buyer_id IN ${uids}`)
  await run(`DELETE FROM name_records WHERE name IN (SELECT name FROM names WHERE seed = 1 OR owner_id IN ${uids})`)
  await run(`DELETE FROM names WHERE seed = 1 OR owner_id IN ${uids}`)
  await run(`DELETE FROM users WHERE seed = 1`)
}

if (import.meta.url === `file://${process.argv[1]}`) { await migrate(); await purgeSeed(); console.log('seed rows removed'); db.close() }
