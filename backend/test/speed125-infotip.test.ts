/** speed.12.5: portalled settings InfoTip sits next to its icon on desktop and mobile. */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
// types ship with the frontend playwright install; backend tsc has no module declaration
// @ts-expect-error playwright is bundled as a frontend dependency
import { chromium, type Browser, type Page } from '../../frontend/node_modules/playwright/index.mjs'

const root = join(import.meta.dirname, '../..')
const fe = join(root, 'frontend')
const out = join('/tmp', 'wifly-12.5-infotip')
const CHROME = '/home/box/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'
const MIME: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }

function stage() {
  mkdirSync(out, { recursive: true })
  for (const f of ['app.css', 'theme.css', 'dark.css', 'settings-concepts.css']) {
    writeFileSync(join(out, f), readFileSync(join(fe, 'src/styles', f)))
  }
  const stub = join('/tmp/wifly-12.4-after/fonts-stub.css')
  writeFileSync(join(out, 'fonts-stub.css'), existsSync(stub) ? readFileSync(stub) : '/* no remote fonts */')
  writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="en" data-themed data-theme="light">
<head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <link rel="stylesheet" href="/fonts-stub.css"/><link rel="stylesheet" href="/app.css"/>
  <link rel="stylesheet" href="/theme.css"/><link rel="stylesheet" href="/dark.css"/>
  <link rel="stylesheet" href="/settings-concepts.css"/>
  <style>body{margin:0;background:var(--bg);color:var(--ink)}.wrap{max-width:560px;margin:0 auto;padding:24px 16px 80px;display:grid;gap:18px}</style>
</head>
<body><div id="root"></div><script type="module" src="/demo.js"></script></body></html>`)
  execFileSync('npx', ['esbuild', 'test/settings-infotip.tsx', '--bundle', `--outfile=${join(out, 'demo.js')}`, '--format=esm', '--jsx=automatic'], { cwd: fe, stdio: 'pipe' })
}

let server: Server
let browser: Browser
let base = ''

before(async () => {
  stage()
  server = createServer((req, res) => {
    const p = join(out, decodeURIComponent((req.url || '/').split('?')[0].replace(/^\//, '') || 'index.html'))
    if (!p.startsWith(out) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end('no'); return }
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(readFileSync(p))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
})

after(async () => {
  await browser?.close()
  await new Promise<void>((res, rej) => server?.close(e => e ? rej(e) : res()))
})

async function assertTips(page: Page, label: string) {
  // string form: tsx injects __name into function expressions, which page.evaluate cannot see
  const containing = await page.evaluate(`(() => {
    const cs = (el) => getComputedStyle(el)
    return {
      htmlTransform: cs(document.documentElement).transform,
      bodyTransform: cs(document.body).transform,
      htmlFilter: cs(document.documentElement).filter,
      bodyFilter: cs(document.body).filter,
    }
  })()`) as { htmlTransform: string; bodyTransform: string; htmlFilter: string; bodyFilter: string }
  assert.equal(containing.htmlTransform, 'none', `${label}: html must not have transform`)
  assert.equal(containing.bodyTransform, 'none', `${label}: body must not have transform`)
  assert.equal(containing.htmlFilter, 'none', `${label}: html must not have filter`)
  assert.equal(containing.bodyFilter, 'none', `${label}: body must not have filter`)

  const n = await page.locator('.infotip__btn').count()
  assert.ok(n >= 4, `${label}: expected the four settings info icons, got ${n}`)
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Escape')
    const btn = page.locator('.infotip__btn').nth(i)
    await btn.scrollIntoViewIfNeeded()
    await btn.click()
    const pop = page.locator('[data-testid="infotip-pop"]')
    await pop.waitFor({ state: 'visible' })
    await page.waitForTimeout(40)
    const m = await page.evaluate(`((idx) => {
      const b = document.querySelectorAll('.infotip__btn')[idx]
      const p = document.querySelector('[data-testid="infotip-pop"]')
      const br = b.getBoundingClientRect(), pr = p.getBoundingClientRect()
      const vw = window.innerWidth, vh = window.innerHeight
      const gap = pr.bottom <= br.top + 0.5 ? br.top - pr.bottom
        : pr.top + 0.5 >= br.bottom ? pr.top - br.bottom
        : -1
      const inView = pr.top >= -0.5 && pr.left >= -0.5 && pr.bottom <= vh + 0.5 && pr.right <= vw + 0.5
      return { gap, inView, pr: { top: pr.top, bottom: pr.bottom, left: pr.left, right: pr.right, height: pr.height } }
    })(${i})`) as { gap: number; inView: boolean; pr: { top: number; bottom: number; left: number; right: number; height: number } }
    assert.ok(m.pr.height > 24, `${label} tip ${i}: pop should not be crushed (h=${m.pr.height})`)
    assert.ok(m.inView, `${label} tip ${i}: pop must sit inside the viewport ${JSON.stringify(m.pr)}`)
    assert.ok(m.gap >= 0 && m.gap <= 12, `${label} tip ${i}: pop should sit within ~12px of its icon (gap=${m.gap})`)
  }
}

for (const [label, vp] of [['desktop 1440x900', { width: 1440, height: 900 }], ['mobile 390x844', { width: 390, height: 844 }]] as const) {
  test(`settings InfoTip sits next to each icon (${label})`, async () => {
    const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 })
    await page.goto(base + '/', { waitUntil: 'networkidle' })
    await assertTips(page, label)
    await page.close()
  })
}
