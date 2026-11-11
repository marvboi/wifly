import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { cleanHandle, handleFieldState, handleFieldError, HANDLE_MAX, HANDLE_MIN, type HandleCheck } from '../../frontend/src/lib/handleName'
import { SIGNED_OUT, blockSessionRestore, sessionRestoreBlocked, allowSessionRestore } from '../../frontend/src/lib/sessionRestore'
import { PRIVY_SESSION_KEYS, clearPrivySessionStorage } from '../../frontend/src/lib/privySession'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

function memoryStore(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init))
  const store = {
    get length() { return map.size },
    key(i: number) { return [...map.keys()][i] ?? null },
    getItem(k: string) { return map.has(k) ? map.get(k)! : null },
    setItem(k: string, v: string) { map.set(k, String(v)) },
    removeItem(k: string) { map.delete(k) },
    entries() { return Object.fromEntries(map) },
  }
  return store
}

test('package and settings version is 0.12.6.13', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(src('pages/Settings.tsx'), />0\.12\.6\.13</)
  assert.doesNotMatch(src('pages/Settings.tsx'), /0\.12\.6\.2/)
})

test('approved copy is gone: hint and “free, and yours.” no longer appear', () => {
  const welcome = src('pages/Welcome.tsx')
  const handle = src('components/HandleField.tsx')
  const css = src('styles/app.css')
  assert.doesNotMatch(welcome, /free, and yours/)
  assert.doesNotMatch(handle, /a–z, 0–9 and _/)
  assert.doesNotMatch(handle, /\$\{value\.length\}\/\{HANDLE_MAX\}/)
  assert.doesNotMatch(css, /0\/20/)
  assert.match(welcome, /who are you\?/)
  assert.match(welcome, /display name/)
  assert.match(welcome, /already have an account\?/)
  assert.match(welcome, /sign in with x or email instead/)
  assert.match(src('components/WalletProofs.tsx'), /already own a \.wif\? use it/)
  assert.match(welcome, /<PlayfulMarksBg/)
})

test('cleanHandle lowercases, strips invalid characters, and caps at HANDLE_MAX', () => {
  assert.equal(cleanHandle('ABC'), 'abc')
  assert.equal(cleanHandle('@Hello_World'), 'hello_world')
  assert.equal(cleanHandle('na me!'), 'name')
  assert.equal(cleanHandle('ok-dash.plus'), 'okdashplus')
  assert.equal(cleanHandle('a'.repeat(HANDLE_MAX + 8)), 'a'.repeat(HANDLE_MAX))
  assert.equal(HANDLE_MIN, 3)
  assert.equal(HANDLE_MAX, 20)
})

test('handle field: empty is idle, spinner while checking, check when available, one error only when bad', () => {
  assert.equal(handleFieldState('', false, undefined), 'idle')
  assert.equal(handleFieldState('', true, undefined), 'idle')
  assert.equal(handleFieldError(undefined, 'idle'), null)

  assert.equal(handleFieldState('blue', true, undefined), 'checking')
  assert.equal(handleFieldError(undefined, 'checking'), null)

  const ok: HandleCheck = { handle: 'blue', available: true, suggestions: [], claimFee: 0 }
  assert.equal(handleFieldState('blue', false, ok), 'ok')
  assert.equal(handleFieldError(ok, 'ok'), null)
  const yours: HandleCheck = { ...ok, reason: 'yours' }
  assert.equal(handleFieldState('blue', false, yours), 'ok')
  assert.equal(handleFieldError(yours, 'ok'), null)

  const short: HandleCheck = { handle: 'ab', available: false, reason: 'invalid', message: `at least ${HANDLE_MIN} characters`, suggestions: [], claimFee: 0 }
  assert.equal(handleFieldState('ab', false, short), 'bad')
  assert.equal(handleFieldError(short, 'bad'), 'at least 3 characters')

  const taken: HandleCheck = { handle: 'blue', available: false, reason: 'taken', suggestions: ['blue1'], claimFee: 0 }
  assert.equal(handleFieldError(taken, 'bad'), 'taken')

  const reserved: HandleCheck = { handle: 'admin', available: false, reason: 'reserved', message: 'that one is reserved', suggestions: [], claimFee: 0 }
  assert.equal(handleFieldError(reserved, 'bad'), 'that one is reserved')

  const listed: HandleCheck = { handle: 'sale', available: false, reason: 'listed', suggestions: [], claimFee: 0 }
  assert.equal(handleFieldError(listed, 'bad'), 'taken · for sale')

  const onchain: HandleCheck = { handle: 'owned', available: false, reason: 'wif-owned', suggestions: [], claimFee: 0 }
  assert.equal(handleFieldError(onchain, 'bad'), 'taken onchain')

  const handleSrc = src('components/HandleField.tsx')
  assert.match(handleSrc, /data-testid="handle-checking"/)
  assert.match(handleSrc, /data-testid="handle-ok"/)
  assert.match(handleSrc, /data-testid="handle-error"/)
  assert.match(handleSrc, /handleFieldError/)
  assert.doesNotMatch(handleSrc, /\{check\?\.reason === 'yours' \? 'yours' : 'available'\}/)
})

test('who are you card uses the stacked premium layout and 12.6.3 CSS', () => {
  assert.match(src('pages/Welcome.tsx'), /welcome__card--you/)
  assert.match(src('pages/Welcome.tsx'), /AvatarPicker size=\{96\}/)
  const css = src('styles/app.css')
  assert.ok(css.includes('speed.12.6.3:'), '12.6.3 welcome rules present')
  assert.ok(css.includes('speed.12.6.1: onboarding card') || css.includes('100dvh'), 'safe-area / 100dvh stay')
  assert.match(css, /\.welcome__card--you \.welcome__profile \{[\s\S]*flex-direction: column/)
  assert.match(css, /\.handle-field__error/)
})

test('sign-out sets a restore block that survives storage cleanup; explicit sign-in clears it', () => {
  const st = memoryStore({
    wifly_guest_key: '0xabc',
    wifly_signed_in: '1',
    'wagmi.store': '{"ok":1}',
    'wifly-theme': 'dark',
  })
  assert.equal(sessionRestoreBlocked(st), false)
  blockSessionRestore(st)
  assert.equal(st.getItem(SIGNED_OUT), '1')
  assert.equal(sessionRestoreBlocked(st), true)
  const session = src('api/session.tsx')
  const restore = src('lib/sessionRestore.ts')
  assert.match(restore, /SIGNED_OUT = 'wifly_signed_out'/)
  assert.match(session, /KEEP_ON_SIGN_OUT = new Set\(\[GUEST, BROWSE, SIGNED_OUT/)
  assert.match(session, /blockSessionRestore\(\)/)
  assert.match(session, /if \(sessionRestoreBlocked\(\)\) \{ lastTok\.current = null; via\.current = null; void privyBridge\.logout\(\); return \}/)
  assert.match(session, /const signInGuest = useCallback\(async \(\) => \{\s*allowSessionRestore\(\)/)
  assert.match(session, /const signInWallet = useCallback\(async \(addr\?: `0x\$\{string\}`\) => \{\s*allowSessionRestore\(\)/)
  assert.match(session, /const signInPrivy = useCallback\(async \(\) => \{\s*allowSessionRestore\(\)/)
  allowSessionRestore(st)
  assert.equal(sessionRestoreBlocked(st), false)
  assert.equal(st.getItem('wifly_guest_key'), '0xabc', 'block helpers must not touch the guest key')
  assert.equal(st.getItem('wifly-theme'), 'dark')
})

test('clearPrivySessionStorage drops session tokens only, never the guest key or other keys', () => {
  const st = memoryStore({
    'privy:token': 'tok',
    'privy:refresh_token': 'ref',
    'privy:id_token': 'id',
    'privy:embedded-wallet': 'keep-me',
    wifly_guest_key: '0xabc',
    'wifly-theme': 'light',
  })
  assert.equal(PRIVY_SESSION_KEYS.test('privy:token'), true)
  assert.equal(PRIVY_SESSION_KEYS.test('privy:embedded-wallet'), false)
  clearPrivySessionStorage([st])
  assert.equal(st.getItem('privy:token'), null)
  assert.equal(st.getItem('privy:refresh_token'), null)
  assert.equal(st.getItem('privy:id_token'), null)
  assert.equal(st.getItem('privy:embedded-wallet'), 'keep-me')
  assert.equal(st.getItem('wifly_guest_key'), '0xabc')
  assert.equal(st.getItem('wifly-theme'), 'light')
  const bridge = src('auth/privyBridge.ts')
  assert.match(bridge, /clearPrivySessionStorage\(\)/)
  assert.match(bridge, /async logout\(\)/)
  assert.match(bridge, /finally \{/)
})

test('sign-out still disconnects wagmi, calls Privy logout, and keeps the guest key on purpose', () => {
  const session = src('api/session.tsx')
  const start = session.indexOf('const signOut = useCallback')
  const fn = session.slice(start, start + 1600)
  assert.match(fn, /blockSessionRestore\(\)/)
  assert.match(fn, /privyBridge\.logout\(\)/)
  assert.match(fn, /disconnectAsync/)
  assert.match(fn, /\/auth\/logout/)
  assert.match(fn, /clearAccountStorage\(\)/)
  assert.match(session, /wifly_guest_key/)
  assert.match(session, /export function existingGuestKey/)
})
