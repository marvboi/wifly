import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { guestBrowsePath } from '../../frontend/src/lib/guestBrowse'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

test('package and settings version is 0.12.6.13', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(src('pages/Settings.tsx'), />0\.12\.6\.13</)
  assert.doesNotMatch(src('pages/Settings.tsx'), /0\.12\.6\.6/)
})

test('guestBrowsePath only navigates when the user is not already on the feed', () => {
  assert.equal(guestBrowsePath('/', '/home'), '/home')
  assert.equal(guestBrowsePath('/home', '/home'), null)
  assert.equal(guestBrowsePath('/home/', '/home'), null)
  assert.equal(guestBrowsePath('/welcome', '/home'), '/home')
  assert.equal(guestBrowsePath('/', '/'), null)
  assert.equal(guestBrowsePath('/home', '/'), '/')
  assert.equal(guestBrowsePath('/explore', '/'), '/')
})

test('no-key guest tap browses into the feed without restoring a session or minting a key', () => {
  const sheets = src('components/SignInForm.tsx')
  const guest = sheets.match(/const guest = \(\) => \{[\s\S]*?\n  \}/)?.[0] ?? ''
  assert.ok(guest, 'guest handler missing')
  assert.match(guest, /existingGuestKey\(\)/)
  assert.match(guest, /signInGuest\(\)/)
  assert.match(guest, /rememberGuestBrowse\(\)/)
  assert.match(guest, /guestBrowsePath\(/)
  assert.match(guest, /signalGuestBrowse\(\)/)
  assert.match(guest, /appHref\('\/home'\)/)
  assert.match(guest, /nav\(to, \{ state: \{ guestBrowse: true \} \}\)/)
  assert.match(guest, /closeSheet\(\)/)
  assert.doesNotMatch(guest, /allowSessionRestore/)
  assert.doesNotMatch(guest, /generatePrivateKey/)
  // existing-key path still signs in (that path already clears wifly_signed_out)
  assert.match(guest, /if \(existingGuestKey\(\)\) \{ last\.current = 'guest'; gate\.current!\.run\('guest', \(\) => signInGuest\(\)\); return \}/)
})

test('signInGuest still clears the signed-out flag; guest browse never mints a throwaway key', () => {
  const session = src('api/session.tsx')
  assert.match(session, /signInGuest[\s\S]{0,400}allowSessionRestore\(\)/)
  assert.match(session, /export function rememberGuestBrowse/)
  assert.doesNotMatch(session, /generatePrivateKey/)
})

test('both sign-in sheets expose the same guest button copy so a live Privy-first sheet can be tapped', () => {
  const sheets = src('components/SignInForm.tsx')
  const guestBtns = sheets.match(/data-testid="signin-guest"[\s\S]*?try it with a guest key/g) ?? []
  assert.equal(guestBtns.length, 2, `expected guest button on Privy-first and wallet views, got ${guestBtns.length}`)
  assert.match(sheets, /a guest key lives in this browser only\. you can link a wallet later\./)
})

test('signed-out companion sits just above the join bar on desktop; phones stay clear of the raised dock', () => {
  const css = src('styles/app.css')
  // signed-in placement is unchanged
  assert.match(css, /\.cmp-dock \{ position: fixed;[\s\S]*?bottom: calc\(24px \+ env\(safe-area-inset-bottom\)\)/)
  assert.match(css, /@media \(max-width: 720px\) \{\s*\.cmp-dock \{ right: 12px; bottom: calc\(84px \+ env\(safe-area-inset-bottom\)\); \}/)
  // signed-out desktop: same 24px gap, above the join bar — not a full dock-clearance higher
  assert.match(css, /\.app--out \.cmp-dock \{ bottom: calc\(var\(--joinbar-h\) \+ 24px \+ env\(safe-area-inset-bottom, 0px\)\); \}/)
  // signed-out phones: still above the raised dock so the face does not cover icons
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.app--out \.cmp-dock \{ bottom: calc\(var\(--joinbar-h\) \+ var\(--dock-clearance\) \+ 16px\); \}/)
  // stage padding (clears the stacked chrome) stays the same
  assert.match(css, /\.app--out \.stage \{ padding-bottom: calc\(var\(--dock-clearance\) \+ var\(--joinbar-h\) \+ var\(--cmp-dock-h\) \+ 16px\)/)
})
