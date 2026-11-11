import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  PLAY_HOT_PX,
  PLAY_LERP,
  atRest,
  clampNorm,
  isHotAt,
  layoutCenter,
  lerp,
  lerpToward,
  orientationNorm,
  playNorm,
} from '../../frontend/src/lib/playfulMarksMotion'
import { handleFaceMood, handleFieldError, handleLogoReplacesError, type HandleCheck } from '../../frontend/src/lib/handleName'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

test('package and settings version is 0.12.6.13', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(src('pages/Settings.tsx'), />0\.12\.6\.13</)
  assert.doesNotMatch(src('pages/Settings.tsx'), /0\.12\.6\.5/)
})

test('mouse follow helpers lerp toward a target and snap at rest', () => {
  assert.equal(lerp(0, 10, 0.5), 5)
  assert.equal(lerpToward(0, 1, PLAY_LERP), PLAY_LERP)
  assert.equal(lerpToward(0.9996, 1, PLAY_LERP), 1)
  assert.ok(atRest(0, 0, 0, 0))
  assert.equal(atRest(0, 0, 0.5, 0), false)
  const n = playNorm(150, 50, { left: 100, top: 0, width: 100, height: 100 })
  assert.equal(n.x, 0)
  assert.equal(n.y, 0)
  const edge = playNorm(200, 100, { left: 100, top: 0, width: 100, height: 100 })
  assert.equal(edge.x, 1)
  assert.equal(edge.y, 1)
  assert.deepEqual(clampNorm(3, -4), { x: 1, y: -1 })
  const c = layoutCenter({ left: 10, top: 20 }, { offsetLeft: 30, offsetTop: 40, offsetWidth: 20, offsetHeight: 10 })
  assert.deepEqual(c, { x: 50, y: 65 })
  assert.equal(isHotAt(0, 0, 0, 0), true)
  assert.equal(isHotAt(0, 0, PLAY_HOT_PX, 0), false)
  const o = orientationNorm(18, 45)
  assert.deepEqual(o, { x: 1, y: 0 })
})

test('bounce and mouse offset sit on separate wrappers; mouse layer has no transform transition', () => {
  const bg = src('components/PlayfulMarksBg.tsx')
  const css = src('styles/app.css')
  assert.match(bg, /playful-marks__drift/)
  assert.match(bg, /playful-marks__react/)
  assert.match(bg, /lerpToward/)
  assert.match(bg, /requestAnimationFrame\(tick\)/)
  assert.match(bg, /prefers-reduced-motion/)
  assert.match(bg, /layoutCenter/)
  assert.match(src('pages/Welcome.tsx'), /<PlayfulMarksBg/)

  const start = css.indexOf('speed.12.6.6:')
  assert.ok(start >= 0, '12.6.6 placement rules present')
  const marker = '.playful-marks__react {\n  transform: translate3d(calc(var(--play-x)'
  const at = css.indexOf(marker, start)
  assert.ok(at >= 0, 'mouse-offset react rule present')
  const reactRule = css.slice(at, css.indexOf('}', at) + 1)
  assert.match(reactRule, /var\(--play-x\)/)
  assert.match(reactRule, /transition:\s*scale/)
  assert.doesNotMatch(reactRule, /transition:[^;]*transform/)
  assert.match(css, /@keyframes playful-mark-drift/)
  assert.match(css, /50% \{ translate: 10px -14px; \}/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
})

test('reserved and taken drop their status word and reuse the picker Mascot in the oops state', () => {
  const reserved: HandleCheck = { handle: 'admin', available: false, reason: 'reserved', message: 'that one is reserved', suggestions: [], claimFee: 0 }
  const taken: HandleCheck = { handle: 'blue', available: false, reason: 'taken', suggestions: ['blue1'], claimFee: 0 }
  const listed: HandleCheck = { handle: 'for', available: false, reason: 'listed', suggestions: [], claimFee: 0, price: 10 }
  const onchain: HandleCheck = { handle: 'held', available: false, reason: 'wif-owned', suggestions: [], claimFee: 0 }
  const short: HandleCheck = { handle: 'ab', available: false, reason: 'invalid', message: 'at least 3 characters', suggestions: [], claimFee: 0 }

  assert.equal(handleLogoReplacesError('reserved'), true)
  assert.equal(handleLogoReplacesError('taken'), true)
  assert.equal(handleLogoReplacesError('x-reserved'), true)
  assert.equal(handleLogoReplacesError('listed'), false)
  assert.equal(handleLogoReplacesError('wif-owned'), false)
  assert.equal(handleLogoReplacesError('invalid'), false)

  // helper wording is unchanged; the field just does not render these two
  assert.equal(handleFieldError(reserved, 'bad'), 'that one is reserved')
  assert.equal(handleFieldError(taken, 'bad'), 'taken')
  assert.equal(handleFieldError(listed, 'bad'), 'taken · for sale')
  assert.equal(handleFieldError(onchain, 'bad'), 'taken onchain')
  assert.equal(handleFieldError(short, 'bad'), 'at least 3 characters')

  assert.equal(handleFaceMood('admin', 'bad', 'reserved'), 'oops')
  assert.equal(handleFaceMood('blue', 'bad', 'taken'), 'oops')
  assert.equal(handleFaceMood('x', 'ok'), 'happy')
  assert.equal(handleFaceMood('abc', 'checking'), 'think')
  assert.equal(handleFaceMood('', 'idle'), 'calm')
  assert.equal(handleFaceMood('ab', 'bad', 'invalid'), 'think')

  const field = src('components/HandleField.tsx')
  assert.match(field, /<Mascot size=\{32\} tile=\{false\} mood=\{mood\} pulse=\{hop\}/)
  const inputAt = field.indexOf('<input ')
  const trailAt = field.indexOf('handle-field__trail')
  const faceAt = field.indexOf('handle-field__face')
  assert.ok(inputAt >= 0 && trailAt > inputAt && faceAt > trailAt, 'mascot sits in the right-side trail after the input')

  assert.match(field, /handleLogoReplacesError/)
  assert.match(field, /showError/)
  assert.match(field, /from '\.\/Mascot'/)
  // same component the .wif picker uses
  assert.match(src('pages/Names.tsx'), /<Mascot size=\{40\} tile=\{false\} mood=\{mood\} pulse=\{hop\}/)
})

test('12.6.6 changes no other onboarding copy and does not touch env files', () => {
  const welcome = src('pages/Welcome.tsx')
  assert.match(welcome, /who are you\?/)
  assert.match(welcome, /already have an account\?/)
  assert.match(welcome, /sign in with x or email instead/)
  assert.match(src('components/WalletProofs.tsx'), /already own a \.wif\? use it/)
  const envExample = readFileSync(join(root, 'frontend/.env.example'), 'utf8')
  const packed = execSync(
    'tar -xOf /workspace/wifly-checkpoint-speed.12.6.5.tar.gz wifly-settings-concepts-work/frontend/.env.example',
    { encoding: 'utf8' },
  )
  assert.equal(envExample, packed)
})
