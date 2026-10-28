// light by default: new visitors and anyone who never picked a theme get light, even on a dark device
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const { THEME_INIT, THEME_KEY, THEME_PICKED_KEY, themePrefFrom } = await import('../../frontend/theme-init.mjs')

/** run the no-flash script against a fake page: what data-theme does it paint before first paint? */
function paint(store: Record<string, string>, deviceDark = true) {
  const attrs: Record<string, string> = {}
  const style: Record<string, string> = {}
  const document = { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v }, style } }
  const localStorage = { getItem: (k: string) => (k in store ? store[k] : null) }
  const matchMedia = (q: string) => ({ matches: deviceDark && q.includes('dark') })
  runInNewContext(THEME_INIT, { document, localStorage, matchMedia, window: { matchMedia } })
  return { theme: attrs['data-theme'], bg: style.backgroundColor, scheme: style.colorScheme }
}

test('no-flash script: light is the default, even with the device on dark', () => {
  assert.deepEqual(paint({}), { theme: 'light', bg: '#FFFFFF', scheme: 'light' }, 'a new visitor gets light')
  assert.equal(paint({ [THEME_KEY]: 'system' }).theme, 'light', 'an old auto saved without a pick is not a choice')
  assert.equal(paint({ [THEME_KEY]: 'auto' }).theme, 'light')
  assert.equal(paint({ [THEME_KEY]: 'nonsense' }).theme, 'light')
  assert.equal(paint({ [THEME_KEY]: 'light', [THEME_PICKED_KEY]: '1' }).theme, 'light')
})

test('no-flash script: an explicit dark or auto pick is kept', () => {
  assert.equal(paint({ [THEME_KEY]: 'dark' }).theme, 'dark', 'dark saved by an older build was a pick (only the toggle ever wrote it)')
  assert.equal(paint({ [THEME_KEY]: 'dark', [THEME_PICKED_KEY]: '1' }).theme, 'dark')
  assert.equal(paint({ [THEME_KEY]: 'system', [THEME_PICKED_KEY]: '1' }, true).theme, 'dark', 'picked auto follows a dark device')
  assert.equal(paint({ [THEME_KEY]: 'system', [THEME_PICKED_KEY]: '1' }, false).theme, 'light', 'picked auto follows a light device')
  // a throwing localStorage (private mode) still paints light
  const attrs: Record<string, string> = {}
  runInNewContext(THEME_INIT, { document: { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v }, style: {} } }, localStorage: { getItem: () => { throw new Error('no') } }, matchMedia: () => ({ matches: true }), window: { matchMedia: () => ({ matches: true }) } })
  assert.equal(attrs['data-theme'], 'light')
})

test('app reads the same choice: toggle and more-sheet default to light', () => {
  assert.equal(themePrefFrom(null, null), 'light')
  assert.equal(themePrefFrom('system', null), 'light')
  assert.equal(themePrefFrom('auto', '1'), 'light')
  assert.equal(themePrefFrom('system', '1'), 'system')
  assert.equal(themePrefFrom('dark', null), 'dark')
  assert.equal(themePrefFrom('light', null), 'light')
  const src = readFileSync(new URL('../../frontend/src/lib/theme.ts', import.meta.url), 'utf8')
  assert.match(src, /localStorage\.setItem\(THEME_PICKED_KEY, '1'\)/, 'every pick saves the marker')
  assert.ok(!/removeItem\(THEME_KEY\)/.test(src), 'auto is saved, not removed (removed reads as never picked)')
  assert.match(src, /useSyncExternalStore\(subscribe, snap, \(\) => 'light:light'\)/, 'server snapshot is light')
  const session = readFileSync(new URL('../../frontend/src/api/session.tsx', import.meta.url), 'utf8')
  assert.match(session, /'wifly-theme-picked'/, 'sign out keeps the pick')
})

test('meta theme-color starts light, and the csp has the new script hash', async () => {
  const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8')
  assert.match(html, /<meta name="theme-color" content="#ffffff"/i)
  const { THEME_INIT_HASH } = await import('../../frontend/security-headers.mjs')
  assert.ok(readFileSync(new URL('../../frontend/Caddyfile', import.meta.url), 'utf8').includes(THEME_INIT_HASH))
})
