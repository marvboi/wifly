import { createRequire } from 'node:module'
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts')
const { createSiweMessage } = require('viem/siwe')
import { mkdirSync, readFileSync } from 'node:fs'

/** Needs preview on :4173, API on :8787, and a build with VITE_NAMES_ADDRESS set so .wif claim UI is live. */
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

async function onboardedUser(ctx, page) {
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
    data: { message, signature },
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
  {
    name: 'plus-phone-light',
    path: '/plus',
    dark: false,
    action: async page => {
      await page.getByTestId('plus-perks').waitFor({ state: 'visible', timeout: 15000 })
      await page.getByText(/3[,.]?000/).first().waitFor({ state: 'visible', timeout: 10000 })
      const fee = page.getByText('where your wif goes', { exact: false }).first()
      if (await fee.isVisible().catch(() => false)) await fee.scrollIntoViewIfNeeded()
    },
    verify: async page => {
      const txt = await page.locator('main').first().innerText()
      if (!/3[,.]?000/.test(txt)) throw new Error('expected 3,000 monthly price visible')
      if (!/burn/i.test(txt) || !/2\s*%/.test(txt)) throw new Error('expected burn · 2% fee row')
    },
  },
  {
    name: 'plus-phone-dark',
    path: '/plus',
    dark: true,
    action: async page => {
      await page.getByText(/3[,.]?000/).first().waitFor({ state: 'visible', timeout: 10000 })
    },
    verify: async page => {
      const txt = await page.locator('main').first().innerText()
      if (!/3[,.]?000/.test(txt)) throw new Error('expected 3,000 monthly price visible')
    },
  },
  {
    name: 'plus-desktop-light',
    path: '/plus',
    dark: false,
    viewport: { width: 1280, height: 900 },
    action: async page => {
      await page.getByText(/3[,.]?000/).first().waitFor({ state: 'visible', timeout: 10000 })
      const fee = page.getByText('where your wif goes', { exact: false }).first()
      if (await fee.isVisible().catch(() => false)) await fee.scrollIntoViewIfNeeded()
    },
    verify: async page => {
      const txt = await page.locator('main').first().innerText()
      if (!/burn/i.test(txt)) throw new Error('expected burn fee row on desktop plus')
    },
  },
  {
    name: 'earnings-phone-light',
    path: '/earnings?demo=earnings',
    dark: false,
    verify: async page => {
      const row = page.locator('.earnings-kv__row').first()
      await row.waitFor({ state: 'visible', timeout: 8000 })
      const valueBox = await row.locator('.earnings-kv__value').boundingBox()
      const rowBox = await row.boundingBox()
      if (!valueBox || !rowBox) throw new Error('earnings row layout missing')
      if (valueBox.x + valueBox.width < rowBox.x + rowBox.width * 0.55) throw new Error('earnings value not right-aligned')
    },
  },
  { name: 'earnings-phone-dark', path: '/earnings?demo=earnings', dark: true },
  { name: 'names-claim-2char-light', path: '/names', dark: false, auth: true, action: async page => {
    await page.locator('input[aria-label="name to claim"]').fill('ab')
    await page.getByText('ab.wif is available', { exact: false }).waitFor({ state: 'visible', timeout: 15000 })
    await page.getByTestId('claim-price').waitFor({ state: 'visible', timeout: 8000 })
    const price = await page.getByTestId('claim-price').innerText()
    if (!/8[,.]?000/.test(price)) throw new Error(`expected 8,000 wif claim price, got: ${price}`)
    await page.getByTestId('claim-go').scrollIntoViewIfNeeded()
  } },
  { name: 'names-claim-2char-dark', path: '/names', dark: true, auth: true, action: async page => {
    await page.locator('input[aria-label="name to claim"]').fill('ab')
    await page.getByText('ab.wif is available', { exact: false }).waitFor({ state: 'visible', timeout: 15000 })
    await page.getByTestId('claim-price').waitFor({ state: 'visible', timeout: 8000 })
    const price = await page.getByTestId('claim-price').innerText()
    if (!/8[,.]?000/.test(price)) throw new Error(`expected 8,000 wif claim price, got: ${price}`)
    await page.getByTestId('claim-go').scrollIntoViewIfNeeded()
  } },
  {
    name: 'boost-sheet-phone-light',
    path: '/post/p1',
    dark: false,
    auth: true,
    verify: async page => {
      const sheet = page.locator('.sheet:visible')
      await sheet.waitFor({ state: 'visible', timeout: 8000 })
      await sheet.getByText('boost this post', { exact: true }).waitFor({ state: 'visible', timeout: 8000 })
      if (await page.getByText('link to continue').isVisible().catch(() => false)) throw new Error('guest link sheet instead of boost')
      if (await page.getByText('who are you?').isVisible().catch(() => false)) throw new Error('still on welcome onboarding')
    },
    action: async page => {
      const notNow = page.getByRole('button', { name: /not now/i })
      if (await notNow.isVisible().catch(() => false)) await notNow.click()
      const btn = page.getByRole('button', { name: /boost this post/i }).first()
      await btn.waitFor({ state: 'visible', timeout: 15000 })
      await btn.click()
      await page.locator('.sheet:visible').first().waitFor({ state: 'visible', timeout: 10000 })
    },
  },
  {
    name: 'boost-sheet-phone-dark',
    path: '/post/p1',
    dark: true,
    auth: true,
    verify: async page => {
      const sheet = page.locator('.sheet:visible')
      await sheet.getByText('boost this post', { exact: true }).waitFor({ state: 'visible', timeout: 8000 })
    },
    action: async page => {
      const notNow = page.getByRole('button', { name: /not now/i })
      if (await notNow.isVisible().catch(() => false)) await notNow.click()
      const btn = page.getByRole('button', { name: /boost this post/i }).first()
      await btn.waitFor({ state: 'visible', timeout: 15000 })
      await btn.click()
      await page.locator('.sheet:visible').first().waitFor({ state: 'visible', timeout: 10000 })
    },
  },
]

const browser = await chromium.launch()
for (const s of shots) {
  const vp = s.viewport ?? { width: 390, height: 844 }
  const ctx = await browser.newContext({
    viewport: vp,
    colorScheme: s.dark ? 'dark' : 'light',
  })
  await ctx.addInitScript(themeInitScript(s.dark), { dark: s.dark })
  const page = await ctx.newPage()
  if (s.auth) await onboardedUser(ctx, page)
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