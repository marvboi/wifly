import { createRequire } from 'node:module'
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts')
const { createSiweMessage } = require('viem/siwe')
import { mkdirSync, readFileSync } from 'node:fs'

const base = process.env.BASE_URL || 'http://127.0.0.1:4173'
const out = '/opt/cursor/artifacts/flat-ui'
mkdirSync(out, { recursive: true })

const GUEST_PK = generatePrivateKey()
const GUEST_ACCT = privateKeyToAccount(GUEST_PK)
const HDR = { 'x-wifly': '1' }

function themeInitScript(dark) {
  return ({ dark: d }) => {
    localStorage.setItem('wifly-theme', d ? 'dark' : 'light')
    localStorage.setItem('wifly-theme-picked', '1')
  }
}

async function assertTheme(page, dark) {
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  if (dark ? theme !== 'dark' : theme === 'dark') {
    throw new Error(`expected ${dark ? 'dark' : 'light'} theme, got data-theme=${theme}`)
  }
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  console.log('  theme', theme, 'body bg', bg)
}

async function onboardedGuest(ctx, page) {
  await ctx.addInitScript(themeInitScript(false))
  await ctx.addInitScript(pk => { localStorage.setItem('wifly_guest_key', pk) }, GUEST_PK)
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const host = new URL(base).host
  const { nonce } = await page.request.get(`${base}/api/auth/nonce`, { headers: HDR }).then(r => r.json())
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
  const vr = await page.request.post(`${base}/api/auth/verify`, {
    data: { message, signature, guest: true },
    headers: { ...HDR, 'content-type': 'application/json' },
  })
  if (!vr.ok()) throw new Error(`guest verify ${vr.status()}`)
  const handle = `shot${Date.now().toString(36).slice(-6)}`
  const ob = await page.request.post(`${base}/api/onboarding`, {
    data: { handle, name: 'local shot', bio: 'screenshot user', follow: ['junoflat'], tags: ['wif'] },
    headers: { ...HDR, 'content-type': 'application/json' },
  })
  if (!ob.ok()) throw new Error(`onboarding ${ob.status()} ${await ob.text()}`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
}

const shots = [
  { name: 'earnings-phone-light', path: '/earnings?demo=earnings', dark: false },
  { name: 'earnings-phone-dark', path: '/earnings?demo=earnings', dark: true },
  { name: 'names-claim-2char-light', path: '/names', dark: false, auth: true, action: async page => {
    await page.locator('input[aria-label="name to claim"]').fill('ab')
    await page.waitForTimeout(900)
    await page.getByTestId('claim-price').waitFor({ state: 'visible', timeout: 8000 })
    await page.getByTestId('claim-go').scrollIntoViewIfNeeded()
  } },
  { name: 'names-claim-2char-dark', path: '/names', dark: true, auth: true, action: async page => {
    await page.locator('input[aria-label="name to claim"]').fill('ab')
    await page.waitForTimeout(900)
    await page.getByTestId('claim-price').waitFor({ state: 'visible', timeout: 8000 })
    await page.getByTestId('claim-go').scrollIntoViewIfNeeded()
  } },
  {
    name: 'boost-sheet-phone-light',
    path: '/post/p1',
    dark: false,
    auth: true,
    verify: async page => {
      const title = page.getByText('boost this post', { exact: true })
      await title.waitFor({ state: 'visible', timeout: 8000 })
      if (await page.getByText('who are you?').isVisible().catch(() => false)) throw new Error('still on welcome onboarding')
    },
    action: async page => {
      const btn = page.getByRole('button', { name: /boost this post/i }).first()
      await btn.waitFor({ state: 'visible', timeout: 15000 })
      await btn.click()
      await page.locator('.sheet').first().waitFor({ state: 'visible', timeout: 10000 })
      await page.getByText('boost this post', { exact: true }).waitFor({ state: 'visible', timeout: 8000 })
    },
  },
  {
    name: 'boost-sheet-phone-dark',
    path: '/post/p1',
    dark: true,
    auth: true,
    verify: async page => {
      await page.getByText('boost this post', { exact: true }).waitFor({ state: 'visible', timeout: 8000 })
    },
    action: async page => {
      const btn = page.getByRole('button', { name: /boost this post/i }).first()
      await btn.waitFor({ state: 'visible', timeout: 15000 })
      await btn.click()
      await page.locator('.sheet').first().waitFor({ state: 'visible', timeout: 10000 })
    },
  },
]

const browser = await chromium.launch()
for (const s of shots) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: s.dark ? 'dark' : 'light',
  })
  await ctx.addInitScript(themeInitScript(s.dark), { dark: s.dark })
  const page = await ctx.newPage()
  if (s.auth) await onboardedGuest(ctx, page)
  await page.goto(`${base}${s.path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await assertTheme(page, s.dark)
  if (s.action) await s.action(page)
  if (s.verify) await s.verify(page)
  const path = `${out}/${s.name}.png`
  await page.screenshot({ path, fullPage: true })
  const buf = readFileSync(path)
  const isPng = buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG'
  if (!isPng) throw new Error(`bad png ${s.name}`)
  await ctx.close()
  console.log('wrote', s.name)
}
await browser.close()
console.log('done', out)