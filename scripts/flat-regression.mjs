/**
 * Wifly flat regression runner (c40eb1d+). Preview :4173, API :8787.
 * Writes screenshots to /opt/cursor/artifacts/flat-ui/regression/ and prints JSON results.
 */
import { createRequire } from 'node:module'
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const base = process.env.BASE_URL || 'http://127.0.0.1:4173'
const out = '/opt/cursor/artifacts/flat-ui/regression'
mkdirSync(out, { recursive: true })

const PHONE390 = { width: 390, height: 844 }
const PHONE360 = { width: 360, height: 800 }
const DESKTOP = { width: 1440, height: 900 }

const authState = join(out, '.auth-state.json')

function themeInit(dark) {
  return ({ dark: d }) => {
    localStorage.setItem('wifly-theme', d ? 'dark' : 'light')
    localStorage.setItem('wifly-theme-picked', '1')
  }
}

const results = []

function record(id, pass, note = '') {
  results.push({ id, pass, note })
  console.log(pass ? `PASS ${id}` : `FAIL ${id}`, note)
}

async function snap(page, name) {
  const path = `${out}/${name}.png`
  await page.screenshot({ path, fullPage: false })
  return path
}

async function noClip(page, label) {
  const clip = await page.evaluate(() => {
    const el = document.documentElement
    const sw = el.scrollWidth
    const cw = el.clientWidth
    const dock = document.querySelector('.dock')
    const vh = window.innerHeight
    let dockOk = true
    if (dock) {
      const r = dock.getBoundingClientRect()
      dockOk = r.bottom <= vh + 2 && r.top >= vh - 160
    }
    return { sw, cw, overflow: sw > cw + 2, dockOk, vh }
  })
  record(`${label}:no-horizontal-clip`, !clip.overflow, clip.overflow ? `scrollWidth ${clip.sw}` : '')
  record(`${label}:dock-in-viewport`, clip.dockOk, clip.dockOk ? '' : 'dock off-screen')
}

async function runGuest(browser, vp, dark, tag) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: dark ? 'dark' : 'light' })
  await ctx.addInitScript(themeInit(dark), { dark })
  const page = await ctx.newPage()

  const routes = [
    { id: 'feed', path: '/' },
    { id: 'post', path: '/post/p1' },
    { id: 'profile', path: '/@junoflat' },
    { id: 'names-claim', path: '/names' },
    { id: 'names-market', path: '/names?tab=market' },
    { id: 'plus', path: '/plus' },
    { id: 'earnings', path: '/earnings?demo=earnings' },
    { id: 'vote', path: '/vote' },
    { id: 'settings', path: '/settings' },
    { id: 'privacy', path: '/privacy' },
    { id: 'welcome', path: '/welcome' },
    { id: 'search', path: '/search' },
    { id: 'bookmarks', path: '/bookmarks' },
  ]

  for (const r of routes) {
    await page.goto(`${base}${r.path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(400)
    const prefix = `guest-${tag}-${r.id}`
    await snap(page, `${prefix}`)
    await noClip(page, prefix)
  }

  // privacy: must not claim IP storage
  await page.goto(`${base}/privacy`, { waitUntil: 'networkidle', timeout: 60000 })
  const privacyText = await page.locator('main').innerText()
  const badIp = /\b(ip address|your ip|stores? (your )?ip)\b/i.test(privacyText)
  record(`guest-${tag}:privacy-no-ip-copy`, !badIp, badIp ? 'found IP storage wording' : '')

  // guest: paid pages gate via sign-in (browse-only); link-to-continue when guest account (useNeedLink)
  await page.goto(`${base}/plus`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  try {
    await page.getByRole('button', { name: 'sign in' }).first().click({ timeout: 8000 })
    await page.locator('.sheet').first().waitFor({ state: 'visible', timeout: 8000 })
    const gateText = await page.locator('.sheet').first().innerText()
    const gated = /link to continue|sign in/i.test(gateText)
    record(`guest-${tag}:paid-action-gated`, gated, gated ? 'sign-in sheet' : gateText.slice(0, 40))
    await page.keyboard.press('Escape')
  } catch (e) {
    record(`guest-${tag}:paid-action-gated`, false, (e.message ?? 'timeout').slice(0, 60))
  }

  await ctx.close()
}

async function runAuthed(browser, vp, dark, tag) {
  const ctx = await browser.newContext({
    viewport: vp,
    colorScheme: dark ? 'dark' : 'light',
    storageState: authState,
  })
  await ctx.addInitScript(themeInit(dark), { dark })
  const page = await ctx.newPage()

  const routes = [
    { id: 'feed', path: '/' },
    { id: 'post', path: '/post/p1' },
    { id: 'names-mine', path: '/names?tab=mine' },
    { id: 'plus', path: '/plus' },
    { id: 'settings-theme', path: '/settings' },
  ]

  for (const r of routes) {
    await page.goto(`${base}${r.path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(400)
    const prefix = `auth-${tag}-${r.id}`
    await snap(page, prefix)
    await noClip(page, prefix)
  }

  await page.goto(`${base}/post/p1`, { waitUntil: 'domcontentloaded' })
  const boost = page.getByRole('button', { name: /boost this post/i }).first()
  if (await boost.count()) {
    await boost.click()
    await page.locator('.sheet--pay').waitFor({ state: 'visible', timeout: 10000 })
    await snap(page, `auth-${tag}-boost-sheet`)
    const presets = await page.locator('.picker__presets button').allTextContents()
    const presetOk = presets.some(t => /100/.test(t))
    record(`auth-${tag}:boost-presets-100`, presetOk, presets.join(','))
    await page.keyboard.press('Escape')
  }

  await page.goto(`${base}/vote`, { waitUntil: 'domcontentloaded' })
  await snap(page, `auth-${tag}-vote`)
  const voteBtn = page.locator('.chip--vote, button').filter({ hasText: /vote/i }).first()
  if (await voteBtn.count()) {
    await voteBtn.click().catch(() => {})
    await page.waitForTimeout(400)
    await snap(page, `auth-${tag}-vote-sheet`).catch(() => {})
  }

  await ctx.close()
}

import { readFileSync, existsSync } from 'node:fs'

const browser = await chromium.launch()

if (!existsSync(authState)) {
  const shared = '/opt/cursor/artifacts/flat-ui/.auth-state.json'
  if (existsSync(shared)) {
    writeFileSync(authState, readFileSync(shared))
  }
}

for (const [vp, tag] of [
  [PHONE390, '390'],
  [PHONE360, '360'],
  [DESKTOP, 'desktop'],
]) {
  for (const dark of [false, true]) {
    const t = `${tag}-${dark ? 'dark' : 'light'}`
    await runGuest(browser, vp, dark, t)
    if (existsSync(authState)) await runAuthed(browser, vp, dark, t)
  }
}

// scrollbar rule present in built CSS
try {
  const css = readFileSync('/workspace/frontend/src/styles/app.css', 'utf8')
  record('static:scrollbar-styled', /scrollbar/.test(css))
} catch (e) {
  record('static:scrollbar-styled', false, String(e))
}

await browser.close()

const failed = results.filter(r => !r.pass)
writeFileSync(join(out, 'results.json'), JSON.stringify({ commit: 'c40eb1d', at: new Date().toISOString(), results }, null, 2))
console.log('failed', failed.length, 'of', results.length)
process.exit(failed.length ? 1 : 0)