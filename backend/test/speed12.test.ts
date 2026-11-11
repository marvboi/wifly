/** speed.12: resilience (generic 5xx, price last-good, RPC timeout, unhandledRejection), blue tip-stage gap, mobile gutter. */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wifly-12-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
delete process.env.WIFLY_CONTRACT_ADDRESS; delete process.env.REDIS_URL
after(() => rmSync(dir, { recursive: true, force: true }))

const FE = join(import.meta.dirname, '../../frontend/src')
const BE = join(import.meta.dirname, '../src')
const src = (p: string) => readFileSync(join(FE, p), 'utf8')
const be = (p: string) => readFileSync(join(BE, p), 'utf8')

test('frontend api: GET timeout, one retry, SWR last-good, friendly 5xx (no raw server text)', () => {
  const c = src('api/client.ts')
  assert.match(c, /GET_TIMEOUT_MS/)
  assert.match(c, /GET_RETRY_WAIT_MS/)
  assert.match(c, /SWR_PREFIX/)
  assert.match(c, /friendlyHttp/)
  assert.match(c, /sessionStorage/)
  assert.match(c, /wifly is waking up/)
  assert.match(c, /you’re offline|you're offline|offline/)
  assert.match(c, /something broke on our side/)
  assert.doesNotMatch(c, /Internal Server Error/)
})

test('frontend: ErrorBoundary + QueryClient keep last-good while refreshing', () => {
  assert.match(src('components/ErrorBoundary.tsx'), /this bit couldn’t load|this bit couldn't load/)
  assert.match(src('main.tsx'), /ErrorBoundary/)
  assert.match(src('main.tsx'), /placeholderData/)
  assert.match(src('components/Shell.tsx'), /ErrorBoundary label="page"/)
})

test('backend: generic 500 onError, unhandledRejection hook, RPC timeout', () => {
  const app = be('app.ts')
  assert.match(app, /something broke on our side/)
  assert.doesNotMatch(app, /error: err\.stack|err\.message \}, 500/)
  const server = be('server.ts')
  assert.match(server, /unhandledRejection/)
  assert.match(server, /uncaughtException/)
  assert.match(be('chain.ts'), /timeout:\s*8_000/)
})

test('backend price: last-good when upstream fails', () => {
  const p = be('price.ts')
  assert.match(p, /if \(last\) return \{ \.\.\.last, stale:/)
  assert.match(p, /stale-while-revalidate|stale: age/)
  assert.match(p, /KEEP/)
})

test('landing: blue tip-stage gap tightened on mobile (was 4/5 empty middle)', () => {
  const css = src('styles/landing.css')
  assert.match(css, /\.lp-stage \{[^}]*aspect-ratio: 1 \/ 1/)
  assert.match(css, /was 4\/5/)
  assert.match(css, /aspect-ratio: 1 \/ 1/)
  assert.match(css, /gap: 56px/)
})

test('mobile gutter ~20px and card padding breathe', () => {
  const css = src('styles/app.css')
  assert.match(css, /\.stage \{ padding: 10px 20px/)
  assert.match(css, /\.card \{[^}]*padding: 18px/)
  assert.match(css, /\.empty--card \{[^}]*padding: 36px 28px/)
  assert.match(css, /\.drop \{ padding: 18px 18px 14px/)
})

test('copy polish: short natural lines, no raw Internal Server Error on home', () => {
  const home = src('pages/Home.tsx')
  assert.match(home, /couldn’t load the feed|couldn't load the feed/)
  assert.doesNotMatch(home, /\(feed\.error as Error\)\.message/)
  assert.match(src('pages/Agent.tsx'), /resets daily/)
  assert.match(src('components/Shell.tsx'), /tips, straight to you/)
  assert.match(src('pages/Plus.tsx'), /connect a wallet to see your balance/)
})


test('landing Reveal respects reduced-motion (no opacity-0 hold)', () => {
  const tsx = src('pages/Landing.tsx')
  assert.match(tsx, /initial=\{reduce \? false/)
  const css = readFileSync(join(FE, 'styles/landing.css'), 'utf8')
  assert.match(css, /lp-ch__text, \.lp-ch__art[^{]*\{[^}]*opacity: 1 !important/)
})

test('package version is 0.12.x (speed.12 lineage)', () => {
  const pkg = readFileSync(join(FE, '../package.json'), 'utf8')
  assert.match(pkg, /"version": "0\.12\.\d+(\.\d+)?"/)
})

test('onError behaviour: generic 500, HTTPException message preserved', async () => {
  const { Hono } = await import('hono')
  const { HTTPException } = await import('hono/http-exception')
  // Mirror app.ts onError so we can assert without mutating the live matcher
  const mini = new Hono()
  mini.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    console.error(`[api] ${c.req.method} ${c.req.path}`, err)
    return c.json({ error: 'something broke on our side' }, 500)
  })
  mini.get('/boom', () => { throw new Error('secret stack TRACE /home/box/secret.ts:1') })
  mini.get('/http', () => { throw new HTTPException(400, { message: 'bad input' }) })
  const res = await mini.request('http://localhost/boom')
  assert.equal(res.status, 500)
  const body = await res.json() as { error: string }
  assert.equal(body.error, 'something broke on our side')
  assert.doesNotMatch(body.error, /TRACE|secret|stack/i)
  const r2 = await mini.request('http://localhost/http')
  assert.equal(r2.status, 400)
  assert.equal(await r2.text(), 'bad input')
})
