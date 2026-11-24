import { createRequire } from 'node:module'
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts')
const { createSiweMessage } = require('viem/siwe')
import { mkdirSync } from 'node:fs'

const GUEST_PK = generatePrivateKey()
const GUEST_ACCT = privateKeyToAccount(GUEST_PK)

async function seedGuestSession(page) {
  const host = new URL(base).host
  const hdr = { 'x-wifly': '1' }
  const { nonce } = await page.request.get(`${base}/api/auth/nonce`, { headers: hdr }).then(r => r.json())
  const message = createSiweMessage({
    address: GUEST_ACCT.address,
    chainId: 4663,
    domain: host,
    uri: base.replace(/\/$/, ''),
    nonce,
    version: '1',
    statement: 'sign in to wifly. this is a signature, not a transaction: nothing is sent.',
  })
  const signature = await GUEST_ACCT.signMessage({ message })
  const r = await page.request.post(`${base}/api/auth/verify`, {
    data: { message, signature, guest: true },
    headers: { ...hdr, 'content-type': 'application/json' },
  })
  if (!r.ok()) throw new Error(`guest verify ${r.status()}`)
}

const base = process.env.BASE_URL || 'http://127.0.0.1:4173'
const out = '/opt/cursor/artifacts/flat-ui'
mkdirSync(out, { recursive: true })

async function signInGuest(ctx, page) {
  await ctx.addInitScript(pk => { localStorage.setItem('wifly_guest_key', pk); localStorage.setItem('wifly_signed_in', '1') }, GUEST_PK)
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await seedGuestSession(page)
  await page.goto(`${base}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(1200)
}

const shots = [
  { name: 'earnings-desktop-light', path: '/earnings?demo=earnings', w: 1280, h: 800, dark: false },
  { name: 'earnings-desktop-dark', path: '/earnings?demo=earnings', w: 1280, h: 800, dark: true },
  { name: 'earnings-phone-light', path: '/earnings?demo=earnings', w: 390, h: 844, dark: false },
  { name: 'earnings-phone-dark', path: '/earnings?demo=earnings', w: 390, h: 844, dark: true },
  { name: 'plus-desktop-light', path: '/plus', w: 1280, h: 800, dark: false, auth: true },
  { name: 'plus-desktop-dark', path: '/plus', w: 1280, h: 800, dark: true, auth: true },
  { name: 'plus-phone-light-390', path: '/plus', w: 390, h: 844, dark: false, auth: true },
  { name: 'plus-phone-dark-390', path: '/plus', w: 390, h: 844, dark: true, auth: true },
  { name: 'names-claim-2char-light', path: '/names', w: 390, h: 844, dark: false, auth: true, action: async page => {
    await page.locator('input[aria-label="name to claim"]').fill('ab')
    await page.waitForTimeout(900)
  } },
  { name: 'names-claim-2char-dark', path: '/names', w: 390, h: 844, dark: true, auth: true, action: async page => {
    await page.locator('input[aria-label="name to claim"]').fill('ab')
    await page.waitForTimeout(900)
  } },
  { name: 'onboarding-welcome-light', path: '/welcome', w: 390, h: 844, dark: false },
  { name: 'onboarding-welcome-dark', path: '/welcome', w: 390, h: 844, dark: true },
  {
    name: 'boost-sheet-phone-light',
    path: '/post/p1',
    w: 390,
    h: 844,
    dark: false,
    auth: true,
    action: async page => {
      const btn = page.getByRole('button', { name: /boost this post/i }).first()
      await btn.waitFor({ state: 'visible', timeout: 12000 })
      await btn.click()
      await page.locator('.sheet, [role="dialog"]').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
      await page.waitForTimeout(700)
    },
  },
  {
    name: 'boost-sheet-phone-dark',
    path: '/post/p1',
    w: 390,
    h: 844,
    dark: true,
    auth: true,
    action: async page => {
      const btn = page.getByRole('button', { name: /boost this post/i }).first()
      await btn.waitFor({ state: 'visible', timeout: 12000 })
      await btn.click()
      await page.locator('.sheet, [role="dialog"]').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
      await page.waitForTimeout(700)
    },
  },
]

const browser = await chromium.launch()
for (const s of shots) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, colorScheme: s.dark ? 'dark' : 'light' })
  const page = await ctx.newPage()
  if (s.auth) await signInGuest(ctx, page)
  await page.goto(`${base}${s.path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  if (s.action) await s.action(page)
  await page.screenshot({ path: `${out}/${s.name}.png`, fullPage: true })
  await ctx.close()
  console.log('wrote', s.name)
}
await browser.close()
console.log('done', out)