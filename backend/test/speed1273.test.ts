import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

test('package and settings version is 0.12.6.13', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.13"/)
  assert.match(src('pages/Settings.tsx'), />0\.12\.6\.13</)
})

test('own-profile settings entry uses a gear icon, same link and labels', () => {
  const icons = src('components/Icon.tsx')
  assert.match(icons, /\n  settings: <><circle cx="12" cy="12" r="3" \/><path d="M19\.4 15/)
  assert.match(icons, /strokeWidth=\{1\.6\}/)
  const profile = src('pages/Profile.tsx')
  const link = profile.match(/<Link className="btn btn--ghost btn--icon pro-act" to="\/settings"[^>]*>[\s\S]*?<\/Link>/)?.[0] ?? ''
  assert.match(link, /aria-label="settings"/)
  assert.match(link, /title="settings"/)
  assert.match(link, /to="\/settings"/)
  assert.match(link, /<Icon name="settings" size=\{18\} \/>/)
  assert.doesNotMatch(link, /name="more"/)
})

test('other three-dot more icons are unchanged', () => {
  const profile = src('pages/Profile.tsx')
  assert.match(profile, /aria-label="more" aria-expanded=\{open\} aria-haspopup="menu"[\s\S]*?<Icon name="more" size=\{18\} \/>/)
  assert.match(src('components/PostCard.tsx'), /aria-label="more" aria-expanded=\{open\} onClick=\{\(\) => setOpen\(o => !o\)\}><Icon name="more" size=\{18\} \/>/)
  assert.match(src('pages/Messages.tsx'), /aria-label="chat options"[\s\S]*?<Icon name="more" size=\{18\} \/>/)
  assert.match(src('pages/Names.tsx'), /<Icon name="more" size=\{14\} \/> manage records/)
})
