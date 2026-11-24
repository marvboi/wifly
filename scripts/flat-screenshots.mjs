import { createRequire } from 'node:module'
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts')
const { createSiweMessage } = require('viem/siwe')
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Preview :4173, API :8787, build with VITE_NAMES_ADDRESS for live claim UI. */
const base = process.env.BASE_URL || 'http://127.0.0.1:4173'
const out = '/opt/cursor/artifacts/flat-ui'
const authState = join(out, '.auth-state.json')
mkdirSync(out, { recursive: true })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

const GUEST_PK = generatePrivateKey()
const GUEST_ACCT = privateKeyToAccount(GUEST_PK)
const CLAIM2 = `z${(Date.now() % 9) + 1}` // 2-char claim for screenshots (e.g. z3)
const HDR = { 'x-wifly': '1' }

function themeInitScript(dark) {
  return ({ dark: d }) => {
    localStorage.setItem('wifly-theme', d ? 'dark' : 'light')
    localStorage.setItem('wifly-theme-picked', '1')
  }
}

async function assertTheme(page, dark) {
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  if (dark ? theme !== 'dark' : theme === 'dark') throw new Error(`wrong theme: ${theme}`)
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  console.log('  theme', theme, 'body bg', bg)
}

async function pickUsdg(page) {
  const usdg = page.getByRole('radio', { name: /^USDG$/i })
  if (await usdg.count()) {
    await usdg.click()
    await page.waitForTimeout(200)
  }
}

async function snap(page, name) {
  const path = `${out}/${name}.png`
  await page.screenshot({ path, fullPage: false })
  const buf = readFileSync(path)
  if (buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') throw new Error(`bad png ${name}`)
  console.log('wrote', name)
}

async function mintAuthState(browser) {
  rmSync(authState, { force: true })
  const ctx = await browser.newContext({ viewport: PHONE })
  const page = await ctx.newPage()
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
  if (!vr.ok()) throw new Error(`auth verify ${vr.status()}`)
  const handle = `shot${Date.now().toString(36).slice(-6)}`
  const ob = await page.request.post(`${base}/api/onboarding`, {
    data: { handle, name: 'local shot', bio: 'screenshot user', follow: ['junoflat'], tags: ['wif'] },
    headers: { ...HDR, 'content-type': 'application/json' },
  })
  if (!ob.ok()) throw new Error(`onboarding ${ob.status()}`)
  await page.reload({ waitUntil: 'networkidle', timeout: 60000 })
  await ctx.storageState({ path: authState })
  await ctx.close()
  console.log('auth state saved')
}

const shots = [
  {
    name: 'plus-phone-light',
    path: '/plus',
    dark: false,
    action: async page => {
      await pickUsdg(page)
      await page.getByTestId('plus-perks').waitFor({ state: 'visible', timeout: 15000 })
      await page.getByText(/3[,.]?000|~.*USDG/i).first().waitFor({ state: 'visible', timeout: 10000 })
      await page.locator('text=where your wif goes').first().scrollIntoViewIfNeeded()
      await page.evaluate(() => window.scrollBy(0, -72))
    },
  },
  {
    name: 'plus-phone-dark',
    path: '/plus',
    dark: true,
    action: async page => {
      await page.getByText(/3[,.]?000/).first().waitFor({ state: 'visible', timeout: 10000 })
      await page.locator('text=where your wif goes').first().scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'plus-desktop-light',
    path: '/plus',
    dark: false,
    viewport: DESKTOP,
    action: async page => {
      await page.getByText(/3[,.]?000/).first().waitFor({ state: 'visible', timeout: 10000 })
      await page.getByTestId('plus-perks').scrollIntoViewIfNeeded()
      await page.evaluate(() => window.scrollTo(0, 0))
    },
  },
  {
    name: 'earnings-phone-light',
    path: '/earnings?demo=earnings',
    dark: false,
    action: async page => {
      await page.evaluate(() => {
        const dock = document.querySelector('.dock')
        const dockClear = dock ? dock.getBoundingClientRect().height + 32 : 88
        const card = [...document.querySelectorAll('.earnings-card')].find(c => /by source/i.test(c.textContent ?? ''))
        if (!card) return
        const rect = card.getBoundingClientRect()
        const target = rect.bottom - (window.innerHeight - dockClear)
        window.scrollBy(0, target)
      })
    },
  },
  {
    name: 'earnings-phone-dark',
    path: '/earnings?demo=earnings',
    dark: true,
    action: async page => {
      await page.evaluate(() => {
        const dock = document.querySelector('.dock')
        const dockClear = dock ? dock.getBoundingClientRect().height + 32 : 88
        const card = [...document.querySelectorAll('.earnings-card')].find(c => /by source/i.test(c.textContent ?? ''))
        if (!card) return
        const rect = card.getBoundingClientRect()
        const target = rect.bottom - (window.innerHeight - dockClear)
        window.scrollBy(0, target)
      })
    },
  },
  {
    name: 'names-claim-2char-light',
    path: '/names',
    dark: false,
    auth: true,
    action: async page => {
      await page.locator('input[aria-label="name to claim"]').fill(CLAIM2)
      await page.getByText(`${CLAIM2}.wif is available`, { exact: false }).waitFor({ state: 'visible', timeout: 15000 })
      await pickUsdg(page)
      await page.getByTestId('claim-price').waitFor({ state: 'visible', timeout: 8000 })
      await page.locator('.names-claim__checkout').scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'names-claim-2char-dark',
    path: '/names',
    dark: true,
    auth: true,
    action: async page => {
      await page.locator('input[aria-label="name to claim"]').fill(CLAIM2)
      await page.getByText(`${CLAIM2}.wif is available`, { exact: false }).waitFor({ state: 'visible', timeout: 15000 })
      await pickUsdg(page)
      await page.locator('.names-claim__checkout').scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'names-claim-2char-desktop-light',
    path: '/names',
    dark: false,
    auth: true,
    viewport: DESKTOP,
    action: async page => {
      await page.locator('input[aria-label="name to claim"]').fill(CLAIM2)
      await page.getByText(`${CLAIM2}.wif is available`, { exact: false }).waitFor({ state: 'visible', timeout: 15000 })
      await pickUsdg(page)
      await page.locator('.names-claim__checkout').scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'boost-sheet-phone-light',
    path: '/post/p1',
    dark: false,
    auth: true,
    action: async page => {
      const btn = page.getByRole('button', { name: /boost this post/i }).first()
      await btn.waitFor({ state: 'visible', timeout: 15000 })
      await btn.click()
      await page.locator('.sheet--pay').waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(600)
    },
    verify: async page => {
      const sheet = page.locator('.sheet--pay')
      const bg = await sheet.evaluate(el => getComputedStyle(el).backgroundColor)
      if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') throw new Error('boost sheet background transparent')
    },
  },
  {
    name: 'boost-sheet-phone-dark',
    path: '/post/p1',
    dark: true,
    auth: true,
    action: async page => {
      const btn = page.getByRole('button', { name: /boost this post/i }).first()
      await btn.waitFor({ state: 'visible', timeout: 15000 })
      await btn.click()
      await page.locator('.sheet--pay').waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
]

const browser = await chromium.launch()
await mintAuthState(browser)

for (const s of shots) {
  const vp = s.viewport ?? PHONE
  const ctx = await browser.newContext({
    viewport: vp,
    colorScheme: s.dark ? 'dark' : 'light',
    ...(s.auth ? { storageState: authState } : {}),
  })
  await ctx.addInitScript(themeInitScript(s.dark), { dark: s.dark })
  const page = await ctx.newPage()
  await page.goto(`${base}${s.path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await assertTheme(page, s.dark)
  if (s.action) await s.action(page)
  if (s.verify) await s.verify(page)
  await snap(page, s.name)
  await ctx.close()
}
await browser.close()
console.log('done', out)