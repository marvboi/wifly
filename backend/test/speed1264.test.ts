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
  assert.doesNotMatch(src('pages/Settings.tsx'), /0\.12\.6\.3/)
})

test('who are you card keeps wording and drops underlines on welcome links', () => {
  const welcome = src('pages/Welcome.tsx')
  assert.match(welcome, /already have an account\?/)
  assert.match(welcome, /sign in with x or email instead/)
  assert.match(src('components/WalletProofs.tsx'), /already own a \.wif\? use it/)
  assert.match(welcome, /<PlayfulMarksBg/)
  const css = src('styles/app.css')
  assert.ok(css.includes('speed.12.6.4:'), '12.6.4 welcome link rules present')
  const start = css.indexOf('speed.12.6.4:')
  const block = css.slice(start)
  assert.match(block, /\.welcome \.linkbtn \{ text-decoration: none/)
  assert.match(block, /\.welcome \.linkbtn:hover/)
  assert.match(block, /text-decoration: none/)
  assert.doesNotMatch(block, /\.welcome \.linkbtn[^{]*\{[^}]*text-decoration: underline/)
})

test('already-have footer is one centered wrapping line, action is a bold non-underlined link', () => {
  const css = src('styles/app.css')
  const block = css.slice(css.indexOf('speed.12.6.4:'))
  assert.match(block, /\.welcome__already,\s*\.welcome__card--you \.welcome__already \{/)
  assert.match(block, /display: block/)
  assert.match(block, /text-align: center/)
  assert.match(block, /\.welcome__already \.linkbtn/)
  assert.match(block, /font-weight: 650/)
  assert.match(block, /display: inline/)
  // 12.6.4 must override the stacked column from 12.6.2 / 12.6.3
  assert.match(block, /flex-direction: unset/)
})

test('.wif use-it control is a muted, aligned, non-underlined text button', () => {
  const css = src('styles/app.css')
  const block = css.slice(css.indexOf('speed.12.6.4:'))
  assert.match(block, /\.welcome \.usewif--compact \{/)
  assert.match(block, /display: inline-flex/)
  assert.match(block, /align-items: center/)
  assert.match(block, /\.welcome \.usewif--compact \.linkbtn/)
  assert.match(block, /\.welcome \.usewif--compact \.infotip/)
  assert.match(src('components/WalletProofs.tsx'), /usewif--compact/)
  assert.match(src('components/WalletProofs.tsx'), /InfoTip/)
})
