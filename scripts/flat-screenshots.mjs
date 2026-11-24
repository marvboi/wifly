import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const base = process.env.BASE_URL || 'http://127.0.0.1:4173'
const out = '/opt/cursor/artifacts/flat-ui'
mkdirSync(out, { recursive: true })

const shots = [
  { name: 'earnings-desktop-light', path: '/earnings', w: 1280, h: 800, dark: false },
  { name: 'earnings-phone-light', path: '/earnings', w: 390, h: 844, dark: false },
  { name: 'post-boost-phone-light', path: '/', w: 390, h: 844, dark: false },
  { name: 'plus-desktop-light', path: '/plus', w: 1280, h: 800, dark: false },
  { name: 'plus-phone-dark', path: '/plus', w: 390, h: 844, dark: true },
]

const browser = await chromium.launch()
for (const s of shots) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, colorScheme: s.dark ? 'dark' : 'light' })
  const page = await ctx.newPage()
  await page.goto(`${base}${s.path}`, { waitUntil: 'networkidle' })
  await page.screenshot({ path: `${out}/${s.name}.png`, fullPage: true })
  await ctx.close()
}
await browser.close()
console.log('wrote', shots.length, 'screenshots to', out)