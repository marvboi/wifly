/** 11.8.4: the onboarding follow step's pure state (frontend/src/pages/onboardFollow). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { followLabel, followPayload, seedFollow, toggleFollow } from '../../frontend/src/pages/onboardFollow'

const people = [{ handle: 'marvpeggy', youFollow: false }, { handle: 'blue', youFollow: false }, { handle: 'tide', youFollow: false }]

test('nobody is pre-picked: everyone starts as "follow"', () => {
  const seen = new Set<string>()
  const f = seedFollow(new Set(), seen, people)
  assert.equal(f.size, 0)
  assert.ok(people.every(p => followLabel(f.has(p.handle)) === 'follow'))
})

test('tap toggles follow ↔ following, and only tapped people are sent', () => {
  let f = toggleFollow(new Set(), 'blue')
  assert.equal(followLabel(f.has('blue')), 'following')
  assert.equal(followLabel(f.has('marvpeggy')), 'follow')
  assert.deepEqual(followPayload(f), ['blue'])
  f = toggleFollow(f, 'blue')
  assert.deepEqual(followPayload(f), [])
})

test('unticking everyone stays unticked when the list comes back (no re-tick), so continue follows nobody', () => {
  const seen = new Set<string>()
  let f = seedFollow(new Set(), seen, [{ handle: 'blue', youFollow: true }, { handle: 'tide', youFollow: false }])
  assert.deepEqual(followPayload(f), ['blue'])
  f = toggleFollow(f, 'blue')
  f = seedFollow(f, seen, [{ handle: 'blue', youFollow: true }, { handle: 'tide', youFollow: false }]) // refetch / back
  assert.deepEqual(followPayload(f), [])
})

test('people you truly follow already show "following"; a tap survives a refetch', () => {
  const seen = new Set<string>()
  let f = seedFollow(new Set(), seen, people)
  f = toggleFollow(f, 'tide')
  f = seedFollow(f, seen, [...people, { handle: 'newbie', youFollow: true }])
  assert.deepEqual(followPayload(f).sort(), ['newbie', 'tide'])
})
