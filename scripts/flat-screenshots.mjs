import { createRequire } from 'node:module'
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')
import { mkdirSync } from 'node:fs'

const base = process.env.BASE_URL || 'http://127.0.0.1:4173'
const out = '/opt/cursor/artifacts/flat-ui'
mkdirSync(out, { recursive: true })

const shots = [
  { name: 'earnings-desktop-light', path: '/earnings?demo=earnings', w: 1280, h: 800, dark: false },
  { name: 'earnings-phone-light', path: '/earnings?demo=earnings', w: 390, h: 844, dark: false },
  { name: 'plus-desktop-light', path: '/plus', w: 1280, h: 800, dark: false },
  { name: 'plus-phone-light-360', path: '/plus', w: 360, h: 780, dark: false },
  { name: 'plus-phone-light-390', path: '/plus', w: 390, h: 844, dark: false },
  { name: 'plus-phone-dark-390', path: '/plus', w: 390, h: 844, dark: true },
  { name: 'names-claim-2char-light', path: '/names', w: 390, h: 844, dark: false, action: async page => {
    const input = page.locator('input[aria-label="name to claim"]')
    await input.fill('ab')
    await page.waitForTimeout(800)
  } },
  { name: 'onboarding-welcome-light', path: '/welcome', w: 390, h: 844, dark: false },
  {
    name: 'boost-sheet-phone-light',
    path: '/',
    w: 390,
    h: 844,
    dark: false,
    action: async page => {
      const boost = page.getByRole('button', { name: /boost/i }).first()
      if (await boost.isVisible({ timeout: 3000 }).catch(() => false)) {
        await boost.click()
        await page.waitForTimeout(600)
      }
    },
  },
]

const browser = await chromium.launch()
for (const s of shots) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, colorScheme: s.dark ? 'dark' : 'light' })
  const page = await ctx.newPage()
  await page.goto(`${base}${s.path}`, { waitUntil: 'networkidle' })
  if (s.action) await s.action(page)
  await page.screenshot({ path: `${out}/${s.name}.png`, fullPage: true })
  await ctx.close()
}
await browser.close()
console.log('wrote', shots.length, 'screenshots to', out)