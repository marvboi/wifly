/** speed.12.6: signed-out guest browse, pull-to-refresh, viewport-clamped wallet pop, mobile clearance. */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join } from 'node:path'
// @ts-expect-error playwright is bundled as a frontend dependency
import { chromium, type Browser } from '../../frontend/node_modules/playwright/index.mjs'

const root = join(import.meta.dirname, '../..')
const fe = join(root, 'frontend')
const src = (rel: string) => readFileSync(join(fe, 'src', rel), 'utf8')

// same geometry as frontend/src/components/walletPop.ts (kept here so backend tsc stays self-contained)
function placeWalletPop(
  anchor: { top: number; bottom: number; left: number; right: number },
  pop: { width: number; height: number },
  view: { w: number; h: number; floor?: number },
  pad = 8,
  gap = 8,
) {
  const width = Math.min(Math.max(pop.width, 0), Math.max(0, view.w - pad * 2))
  const floor = (view.floor ?? view.h) - pad
  const ceiling = pad
  const spaceBelow = floor - (anchor.bottom + gap)
  const spaceAbove = anchor.top - gap - ceiling
  const up = pop.height > spaceBelow && spaceAbove > spaceBelow
  const maxH = Math.max(120, up ? spaceAbove : spaceBelow)
  const h = Math.min(pop.height, maxH)
  const left = Math.min(Math.max(pad, anchor.right - width), Math.max(pad, view.w - width - pad))
  const top = up ? anchor.top - gap - h : anchor.bottom + gap
  return { top, left, maxH, up, width }
}
const CHROME = '/home/box/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'

test('no new throwaway guest keys: generatePrivateKey is gone from session sign-in', () => {
  const session = src('api/session.tsx')
  assert.doesNotMatch(session, /generatePrivateKey/)
  assert.match(session, /existingGuestKey/)
  assert.match(session, /wifly_guest_key/)
  assert.match(session, /rememberGuestBrowse/)
  assert.match(session, /we never mint a throwaway key|never mint a new key|Never creates one/)
  const sheets = src('components/SignInForm.tsx')
  assert.match(sheets, /try it with a guest key/)
  assert.match(sheets, /a guest key lives in this browser only/)
  assert.match(sheets, /busy === 'guest' \? 'signing…'/)
  assert.match(sheets, /existingGuestKey\(\)/)
  assert.match(sheets, /rememberGuestBrowse\(\)/)
  assert.match(sheets, /closeSheet\(\)/)
})

test('user-visible guest and feed copy is unchanged', () => {
  const sheets = src('components/SignInForm.tsx')
  const social = src('components/Social.tsx')
  const shell = src('components/Shell.tsx')
  const home = src('pages/Home.tsx')
  assert.match(sheets, /\{busy === 'guest' \? 'signing…' : 'try it with a guest key'\}/)
  assert.match(sheets, /a guest key lives in this browser only\. you can link a wallet later\./)
  assert.match(social, /\{count\} new \{count === 1 \? 'drop' : 'drops'\}/)
  assert.match(shell, /pick <span className="topbar__pick-your">your <\/span>@name/)
  assert.match(home, /post anything\. get tipped in \$wif\./)
  assert.match(home, /no posts yet\. be the first\./)
})

test('wallet popover is portaled and clamped to the viewport', () => {
  const chip = src('components/WalletChip.tsx')
  assert.match(chip, /createPortal/)
  assert.match(chip, /wallet-pop--float/)
  assert.match(chip, /placeWalletPop/)
  assert.match(src('components/walletPop.ts'), /Math.min\(Math.max\(pad, anchor.right - width\)/)
  // the pick-@name layout: chip sits left of the button, 320px pop aligned to the chip's right would overflow left
  const at = (vw: number, chipRight: number) => placeWalletPop(
    { top: 10, bottom: 46, left: chipRight - 85, right: chipRight },
    { width: 320, height: 178 },
    { w: vw, h: vw === 360 ? 780 : 844 },
  )
  for (const [vw, right] of [[360, 233.5], [390, 263.5]] as const) {
    const p = at(vw, right)
    assert.ok(p.left >= 8, `${vw}: left ${p.left}`)
    assert.ok(p.left + p.width <= vw - 8, `${vw}: right ${p.left + p.width} > ${vw - 8}`)
    assert.ok(p.top >= 0, `${vw}: top ${p.top}`)
    assert.ok(p.top + Math.min(178, p.maxH) <= (vw === 360 ? 780 : 844), `${vw}: bottom overflows`)
    assert.equal(p.up, false, `${vw}: should open below the header chip`)
  }
  // tall menu on a short screen flips or caps height
  const tall = placeWalletPop({ top: 500, bottom: 540, left: 200, right: 300 }, { width: 320, height: 500 }, { w: 360, h: 780, floor: 700 })
  assert.ok(tall.maxH <= 700 - 8 - 540 - 8 + 1 || tall.up, 'tall pop must flip or cap')
  assert.ok(tall.left >= 8 && tall.left + tall.width <= 352)
})

test('home feed pulls to refresh; guest mobile padding clears the companion', () => {
  const home = src('pages/Home.tsx')
  const css = src('styles/app.css')
  assert.match(home, /<PullToRefresh onRefresh=\{refreshFeed\}/)
  assert.match(src('components/PullToRefresh.tsx'), /data-testid="ptr"/)
  assert.match(css, /--cmp-dock-h:\s*80px/)
  assert.match(css, /\.app--out \.stage \{ padding-bottom: calc\(var\(--dock-clearance\) \+ var\(--joinbar-h\) \+ var\(--cmp-dock-h\) \+ 16px\)/)
  assert.match(css, /\.wallet-pop\.wallet-pop--float/)
  assert.match(css, /\.ptr__mark/)
})


test('onboarding page has a decorative official-logo field that respects reduced motion', () => {
  const welcome = src('pages/Welcome.tsx')
  const plus = src('pages/Plus.tsx')
  const sheets = src('sheets/Sheets.tsx')
  const bg = src('components/PlayfulMarksBg.tsx')
  const css = src('styles/app.css')
  assert.match(welcome, /<PlayfulMarksBg \/>/)
  assert.doesNotMatch(plus, /PlayfulMarksBg|WeeklyProBg/)
  assert.doesNotMatch(sheets, /PlayfulMarksBg|sheet-wrap--playful/)
  assert.match(bg, /wifly-face-animated-ink\.svg/)
  assert.match(bg, /wifly-mark\.svg/)
  assert.match(bg, /aria-hidden="true"/)
  assert.match(bg, /prefers-reduced-motion/)
  assert.match(css, /\.playful-marks/)
  assert.match(css, /pointer-events:\s*none/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.doesNotMatch(bg, /<canvas/)
  // onboarding and plus copy is untouched
  assert.match(welcome, /who are you\?/)
  assert.match(welcome, /pick the @name you want\. everything else stays\./)
  assert.match(plus, /optional\. everything else stays free\./)
})

const MIME: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2' }
const out = '/tmp/wifly-12.6-clearance'
let server: Server
let browser: Browser
let base = ''

before(async () => {
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'app.css'), readFileSync(join(fe, 'src/styles/app.css')))
  writeFileSync(join(out, 'theme.css'), readFileSync(join(fe, 'src/styles/theme.css')))
  writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="en" data-themed data-theme="light">
<head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <link rel="stylesheet" href="/theme.css"/><link rel="stylesheet" href="/app.css"/>
  <style>body{margin:0}.cmp-dock__face{width:66px;height:66px;background:#c8f000;border-radius:22px}</style>
</head>
<body>
<div class="app app--out">
  <header class="topbar"><div class="topbar__inner"><span>wifly</span><span class="topbar__right"><button class="topbar__signin">sign in</button></span></div></header>
  <main class="stage"><div class="page"><div class="home-grid"><div class="column">
    <div class="empty empty--card" data-testid="empty"><p class="strong">no posts yet. be the first.</p><p class="muted small">sign in at the top to post the first drop.</p></div>
  </div></div></div></main>
  <nav class="dock dock--out" aria-label="main" style="height:56px"></nav>
  <aside class="joinbar" data-testid="joinbar"><div class="joinbar__inner"><div class="joinbar__actions"><button class="joinbar__btn joinbar__btn--main">sign in</button></div></div></aside>
  <div class="cmp-dock"><div class="cmp-dock__face"></div></div>
</div>
</body></html>`)
  server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0].replace(/^\//, '') || 'index.html')
    const file = join(out, rel)
    if (!file.startsWith(out) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('no'); return }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
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

for (const [w, h] of [[360, 780], [390, 844]] as const) {
  test(`guest home at ${w}x${h}: empty card is not covered by the companion, dock or join bar`, async () => {
    const page = await browser.newPage({ viewport: { width: w, height: h } })
    await page.goto(base, { waitUntil: 'load' })
    const r = await page.evaluate(`(() => {
      const box = (sel) => document.querySelector(sel).getBoundingClientRect()
      const empty = box('.empty'), cmp = box('.cmp-dock'), dock = box('.dock'), join = box('.joinbar')
      const overlap = (a, b) => {
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        return w > 1 && h > 1 ? { w, h } : null
      }
      return {
        emptyBottom: empty.bottom,
        cmp: { top: cmp.top, bottom: cmp.bottom },
        oCmp: overlap(empty, cmp),
        oDock: overlap(empty, dock),
        oJoin: overlap(empty, join),
      }
    })()`) as { emptyBottom: number; cmp: { top: number; bottom: number }; oCmp: unknown; oDock: unknown; oJoin: unknown }
    await page.close()
    assert.equal(r.oCmp, null, `${w}: companion overlaps empty card ${JSON.stringify(r.oCmp)} emptyBottom=${r.emptyBottom} cmpTop=${r.cmp.top}`)
    assert.equal(r.oDock, null, `${w}: dock overlaps empty card ${JSON.stringify(r.oDock)}`)
    assert.equal(r.oJoin, null, `${w}: joinbar overlaps empty card ${JSON.stringify(r.oJoin)}`)
  })
}
