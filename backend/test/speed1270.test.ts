import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SLOTS } from '../../frontend/src/components/PlayfulMarksBg'
import { consumeGuestBrowse, guestBrowsePath, peekGuestBrowsePending, signalGuestBrowse } from '../../frontend/src/lib/guestBrowse'
import {
  MARK_CLEAR_PAD,
  MARK_CLEAR_SELECTORS,
  MARK_SPARSE_MAX_WIDTH,
  MARK_SPARSE_SIZE,
  clearMark,
  inflate,
  overlaps,
  packingHits,
  placeSlots,
  rect,
} from '../../frontend/src/lib/playfulMarksClear'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

test('package and settings version is 0.12.6.13', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(src('pages/Settings.tsx'), />0\.12\.6\.13</)
  assert.doesNotMatch(src('pages/Settings.tsx'), /0\.12\.6\.9/)
})

test('a mark overlapping the wordmark is nudged clear of chrome', () => {
  const wordmark = { left: 24, top: 24, right: 90, bottom: 48 }
  const card = { left: 18, top: 227, right: 372, bottom: 617 }
  const red = rect(-12, 17, 96)
  assert.equal(overlaps(red, wordmark), true)
  const moved = clearMark(red, [inflate(wordmark, MARK_CLEAR_PAD), inflate(card, MARK_CLEAR_PAD)])
  assert.equal(overlaps(moved, inflate(wordmark, MARK_CLEAR_PAD)), false)
  assert.equal(overlaps(moved, inflate(card, MARK_CLEAR_PAD)), false)
  assert.equal(moved.right - moved.left, 96)
})

/** Chrome geometry measured from the 12.6.10 welcome / onboarding layouts (field-relative). */
const GEOMETRIES = [
  {
    name: '390x844', surface: 'welcome', w: 390, h: 844,
    zones: [
      { left: 18, top: 24, right: 77.28, bottom: 48 },
      { left: 18, top: 227.06, right: 372, bottom: 616.94 },
    ],
  },
  {
    name: '390x844', surface: 'onboarding', w: 390, h: 844,
    zones: [
      { left: 18, top: 16, right: 77.28, bottom: 40 },
      { left: 293, top: 26.5, right: 372, bottom: 29.5 },
      { left: 18, top: 203.09, right: 372, bottom: 738.89 },
      { left: 163, top: 129.09, right: 227, bottom: 193.09 },
    ],
  },
  {
    name: '1280x720', surface: 'welcome', w: 1270, h: 720,
    zones: [
      { left: 155, top: 24, right: 214.28, bottom: 48 },
      { left: 395, top: 173.88, right: 875, bottom: 546.11 },
    ],
  },
  {
    name: '1280x720', surface: 'onboarding', w: 1270, h: 806.28,
    zones: [
      { left: 155, top: 20, right: 214.28, bottom: 44 },
      { left: 1036, top: 30.5, right: 1115, bottom: 33.5 },
      { left: 395, top: 221.59, right: 875, bottom: 758.28 },
      { left: 571, top: 73.59, right: 699, bottom: 201.59 },
    ],
  },
  {
    name: '1440x900', surface: 'welcome', w: 1430, h: 900,
    zones: [
      { left: 235, top: 24, right: 294.28, bottom: 48 },
      { left: 475, top: 263.88, right: 955, bottom: 636.11 },
    ],
  },
  {
    name: '1440x900', surface: 'onboarding', w: 1430, h: 900,
    zones: [
      { left: 235, top: 20, right: 294.28, bottom: 44 },
      { left: 1116, top: 30.5, right: 1195, bottom: 33.5 },
      { left: 475, top: 227, right: 955, bottom: 763.69 },
      { left: 651, top: 79, right: 779, bottom: 207 },
    ],
  },
  {
    name: '1920x1080', surface: 'welcome', w: 1910, h: 1080,
    zones: [
      { left: 475, top: 24, right: 534.28, bottom: 48 },
      { left: 715, top: 353.88, right: 1195, bottom: 726.11 },
    ],
  },
  {
    name: '1920x1080', surface: 'onboarding', w: 1910, h: 1080,
    zones: [
      { left: 475, top: 20, right: 534.28, bottom: 44 },
      { left: 1356, top: 30.5, right: 1435, bottom: 33.5 },
      { left: 715, top: 232.39, right: 1195, bottom: 769.08 },
      { left: 891, top: 84.39, right: 1019, bottom: 212.39 },
    ],
  },
] as const

test('marks do not overlap each other or chrome at 390x844, 1280x720, 1440x900 and 1920x1080, signed-out /welcome and signed-in onboarding', () => {
  assert.equal(SLOTS.length, 24)
  for (const g of GEOMETRIES) {
    const placed = placeSlots(SLOTS, g.w, g.h, g.zones)
    assert.equal(placed.length, SLOTS.length, g.name + ' ' + g.surface)
    const visible = placed.filter(p => !p.hidden)
    assert.ok(visible.length >= 4, `${g.name} ${g.surface} kept ${visible.length}`)
    if (g.w <= MARK_SPARSE_MAX_WIDTH) {
      for (const [i, p] of placed.entries()) {
        if (SLOTS[i].s <= MARK_SPARSE_SIZE) assert.equal(p.hidden, true, `sparse slot ${i} should be stowed at ${g.name}`)
      }
    }
    const hits = packingHits(placed, SLOTS, { left: 0, top: 0, right: g.w, bottom: g.h }, g.zones)
    assert.equal(hits.length, 0, `${g.name} ${g.surface}: ${JSON.stringify(hits)}`)
  }
})

test('PlayfulMarksBg still bounces and mouse-follows; packing stows marks that will not fit', () => {
  const bg = src('components/PlayfulMarksBg.tsx')
  assert.match(bg, /placeSlots\(/)
  assert.match(bg, /useLayoutEffect/)
  assert.match(bg, /playful-marks__drift/)
  assert.match(bg, /playful-marks__react/)
  assert.match(bg, /lerpToward/)
  assert.match(bg, /requestAnimationFrame\(tick\)/)
  assert.match(bg, /playful-marks__mark--stowed/)
  assert.match(bg, /MARK_CLEAR_SELECTORS/)
  for (const sel of MARK_CLEAR_SELECTORS) assert.ok(MARK_CLEAR_SELECTORS.includes(sel))
  assert.match(src('pages/Welcome.tsx'), /<PlayfulMarksBg/)
  const css = src('styles/app.css')
  assert.match(css, /@keyframes playful-mark-drift/)
  assert.match(css, /50% \{ translate: 10px -14px; \}/)
  assert.match(css, /\.playful-marks__react \{\n  transform: translate3d\(calc\(var\(--play-x\)/)
  assert.match(css, /\.playful-marks__mark--sparse \{ display: none; \}/)
  assert.match(css, /\.playful-marks__mark--stowed \{ display: none; \}/)
})

test('landing brand no longer nests a Wordmark link inside another link', () => {
  const landing = src('pages/Landing.tsx')
  assert.match(landing, /<Wordmark to=\{null\} size="md" \/>/)
  assert.doesNotMatch(landing, /lp-nav__brand"[^>]*>\s*<Wordmark size=/)
  const bits = src('components/Bits.tsx')
  assert.match(bits, /to\?: string \| null/)
  assert.match(bits, /if \(!to\) return <span className=\{cls\}/)
})


test('a guest tap from /welcome still shows GuestNudge after the feed mounts, without minting a key', () => {
  signalGuestBrowse()
  assert.equal(peekGuestBrowsePending(), true)
  // the event is lost if the feed is not mounted; the latch must still be readable after the route change
  assert.equal(consumeGuestBrowse(() => false), true)
  assert.equal(peekGuestBrowsePending(), false)
  assert.equal(consumeGuestBrowse(() => false), false)
  assert.equal(consumeGuestBrowse(() => true), true)

  assert.equal(guestBrowsePath('/welcome', '/home'), '/home')
  assert.equal(guestBrowsePath('/welcome', '/'), '/')

  const form = src('components/SignInForm.tsx')
  const guest = form.match(/const guest = \(\) => \{[\s\S]*?\n  \}/)?.[0] ?? ''
  assert.match(guest, /rememberGuestBrowse\(\)/)
  assert.match(guest, /signalGuestBrowse\(\)/)
  assert.match(guest, /nav\(to, \{ state: \{ guestBrowse: true \} \}\)/)
  assert.doesNotMatch(guest, /allowSessionRestore/)
  const noKey = guest.slice(guest.indexOf('rememberGuestBrowse'))
  assert.doesNotMatch(noKey, /signInGuest/)

  const home = src('pages/Home.tsx')
  assert.match(home, /consumeGuestBrowse\(prefersGuestBrowse\)/)
  assert.match(home, /loc\.state\?\.guestBrowse/)
  assert.match(home, /data-testid="guest-browse-nudge"/)
  // desktop hides .feed__inline (rail already has those cards); the top guest nudge must stay visible
  const browseNudge = home.match(/<div className="[^"]*" data-testid="guest-browse-nudge">/)?.[0] ?? ''
  assert.match(browseNudge, /feed__item/)
  assert.doesNotMatch(browseNudge, /feed__inline/)

  assert.match(home, /<GuestNudge/)
  assert.match(src('components/GuestWall.tsx'), /enjoying the read\?/)
})

test('12.6.10 does not change sign-in copy or env', () => {
  const form = src('components/SignInForm.tsx')
  assert.match(form, /join wifly\./)
  assert.match(form, /try it with a guest key/)
  assert.match(src('pages/Welcome.tsx'), /who are you\?/)
  const envExample = readFileSync(join(root, 'frontend/.env.example'), 'utf8')
  assert.match(envExample, /VITE_PRIVY_APP_ID/)
})
