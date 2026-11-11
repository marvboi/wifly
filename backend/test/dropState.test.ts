/** Regression: a bookmark that saved must not flip back when a stale refetch lands, and rapid taps follow the last intent. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToggles, TOGGLE_FIELD, type FlagState, type ToggleKind } from '../../frontend/src/api/dropState'

type Drop = FlagState & { id: string }

function post(id: string, over: Partial<Drop> = {}): Drop {
  return { id, liked: false, passed: false, bookmarked: false, likes: 0, reposts: 0, ...over }
}

async function toggle(
  t: ReturnType<typeof createToggles>,
  live: Map<string, Drop>,
  id: string,
  kind: ToggleKind,
  request: (on: boolean) => Promise<Drop>,
) {
  const cur = live.get(id)
  if (!cur) throw new Error('missing drop')
  const [flag, count] = TOGGLE_FIELD[kind]
  const on = !cur[flag]
  t.setIntent(id, flag, on)
  live.set(id, t.withIntent(id, { ...cur, [flag]: on, ...(count ? { [count]: Math.max(0, (cur[count] ?? 0) + (on ? 1 : -1)) } : {}) }))
  const g = t.nextGen(id, kind)
  try {
    const server = await request(on)
    if (!t.isCurrent(id, kind, g)) return
    live.set(id, t.withIntent(id, server))
  } catch (e) {
    if (!t.isCurrent(id, kind, g)) throw e
    t.revertIntent(id, flag, on)
    const now = live.get(id)
    if (now) live.set(id, t.withIntent(id, { ...now, [flag]: !on, ...(count ? { [count]: Math.max(0, (now[count] ?? 0) + (on ? -1 : 1)) } : {}) }))
    throw e
  }
}

function adopt(t: ReturnType<typeof createToggles>, live: Map<string, Drop>, snapshot: Drop) {
  live.set(snapshot.id, t.adopt(snapshot.id, snapshot))
}

test('a successful bookmark stays saved when a stale feed snapshot arrives after the write', async () => {
  const t = createToggles()
  const live = new Map<string, Drop>([['d1', post('d1')]])
  let finish!: (d: Drop) => void
  const pending = new Promise<Drop>(r => { finish = r })
  const done = toggle(t, live, 'd1', 'bookmark', () => pending)
  assert.equal(live.get('d1')!.bookmarked, true)

  finish(post('d1', { bookmarked: true }))
  await done
  assert.equal(live.get('d1')!.bookmarked, true)

  // in-flight (or cached) feed/thread refetch that still has bookmarked: false
  adopt(t, live, post('d1', { bookmarked: false, likes: 3 }))
  assert.equal(live.get('d1')!.bookmarked, true, 'stale refetch must not unsaved the drop')
  assert.equal(live.get('d1')!.likes, 3, 'other fields from the snapshot still apply')

  // a later matching snapshot may settle
  adopt(t, live, post('d1', { bookmarked: true, likes: 3 }))
  assert.equal(live.get('d1')!.bookmarked, true)
})

test('rapid taps settle on the last intended state even if the first response arrives last', async () => {
  const t = createToggles()
  const live = new Map<string, Drop>([['d1', post('d1')]])
  let finishSave!: (d: Drop) => void
  let finishUnsave!: (d: Drop) => void
  const saveReq = new Promise<Drop>(r => { finishSave = r })
  const unsaveReq = new Promise<Drop>(r => { finishUnsave = r })
  const calls: boolean[] = []

  const first = toggle(t, live, 'd1', 'bookmark', on => { calls.push(on); return on ? saveReq : unsaveReq })
  assert.equal(live.get('d1')!.bookmarked, true)
  const second = toggle(t, live, 'd1', 'bookmark', on => { calls.push(on); return on ? saveReq : unsaveReq })
  assert.equal(live.get('d1')!.bookmarked, false)
  assert.deepEqual(calls, [true, false], 'writes are set saved=true then saved=false, not a blind toggle')

  // first (save) response lands last
  finishUnsave(post('d1', { bookmarked: false }))
  await second
  finishSave(post('d1', { bookmarked: true }))
  await first
  assert.equal(live.get('d1')!.bookmarked, false, 'last tap was unsaved')

  adopt(t, live, post('d1', { bookmarked: true }))
  assert.equal(live.get('d1')!.bookmarked, false, 'stale saved snapshot cannot override the last intent')
})

test('a failed write rolls back only if it is still the latest tap', async () => {
  const t = createToggles()
  const live = new Map<string, Drop>([['d1', post('d1')]])
  let rejectSave!: (e: Error) => void
  let finishUnsave!: (d: Drop) => void
  const saveReq = new Promise<Drop>((_, j) => { rejectSave = j })
  const unsaveReq = new Promise<Drop>(r => { finishUnsave = r })

  const first = toggle(t, live, 'd1', 'bookmark', on => on ? saveReq : unsaveReq)
  assert.equal(live.get('d1')!.bookmarked, true)
  const second = toggle(t, live, 'd1', 'bookmark', on => on ? saveReq : unsaveReq)
  assert.equal(live.get('d1')!.bookmarked, false)
  finishUnsave(post('d1', { bookmarked: false }))
  await second
  rejectSave(new Error('network'))
  await first.catch(e => assert.equal((e as Error).message, 'network'))
  assert.equal(live.get('d1')!.bookmarked, false, 'a failed earlier save must not undo the later unsave')

  // a lone failed save does roll back
  const t2 = createToggles()
  const live2 = new Map<string, Drop>([['d1', post('d1')]])
  const lone = toggle(t2, live2, 'd1', 'bookmark', () => Promise.reject(new Error('nope')))
  assert.equal(live2.get('d1')!.bookmarked, true)
  await lone.catch(() => {})
  assert.equal(live2.get('d1')!.bookmarked, false)
})

test('likes and bookmarks keep independent intent across a stale refetch', async () => {
  const t = createToggles()
  const live = new Map<string, Drop>([['d1', post('d1')]])
  const done = toggle(t, live, 'd1', 'like', async () => post('d1', { liked: true, likes: 1 }))
  assert.equal(live.get('d1')!.liked, true)
  await done
  const book = toggle(t, live, 'd1', 'bookmark', async () => post('d1', { liked: true, likes: 1, bookmarked: true }))
  await book
  adopt(t, live, post('d1', { liked: false, likes: 0, bookmarked: false }))
  assert.equal(live.get('d1')!.liked, true)
  assert.equal(live.get('d1')!.bookmarked, true)
  assert.equal(live.get('d1')!.likes, 1)
})

