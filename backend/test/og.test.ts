/** Link previews: og/twitter tags per route (profile, post, .wif name, default), paid text stays hidden, 1200x630 png cards. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wifly-og-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
delete process.env.REDIS_URL; delete process.env.NAMES_CONTRACT_ADDRESS; delete process.env.NAMES_RENDERER_ADDRESS

const { app } = await import('../src/app')
const { migrate, run } = await import('../src/db')
const { resetRateLimits } = await import('../src/util')
const { clearOgCache } = await import('../src/og')
await migrate()

const now = Date.now()
await run(`INSERT INTO users (address, handle, name, bio, extras, created_at) VALUES ('0x00000000000000000000000000000000000000a1', 'ogalice', 'Alice <b>&', 'makes "calm" things & ships', '{"wifName":"alice"}', ?)`, [now])
await run(`INSERT INTO users (address, handle, name, bio, created_at) VALUES ('0x00000000000000000000000000000000000000a2', 'ogbob', 'bob', '', ?)`, [now])
await run(`INSERT INTO users (address, handle, name, bio, created_at, deleted_at) VALUES ('0x00000000000000000000000000000000000000a3', 'oggone', 'gone', '', ?, ?)`, [now, now])
await run(`INSERT INTO names (name, owner_id, created_at) VALUES ('alice', (SELECT id FROM users WHERE handle='ogalice'), ?)`, [now])
await run(`INSERT INTO drops (id, author_id, text, created_at) VALUES ('ogd1', (SELECT id FROM users WHERE handle='ogalice'), 'first light on the new card. it is drawn onchain 🚀', ?)`, [now])
await run(`INSERT INTO drops (id, author_id, text, locked, created_at) VALUES ('ogd2', (SELECT id FROM users WHERE handle='ogbob'), 'the secret alpha', '{"price":50,"teaser":"","unlocks":0}', ?)`, [now])
await run(`INSERT INTO drops (id, author_id, text, supporters_only, created_at) VALUES ('ogd3', (SELECT id FROM users WHERE handle='ogbob'), 'members only words', '1', ?)`, [now])

/** what caddy does for a crawler: /api/og/page + the shared path, original host forwarded */
async function head(path: string, host = 'app.wifly.fun') {
  const p = path.split(/[?#]/)[0].split('/').map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/')
  const r = await app.request(`http://localhost/api/og/page${p}`, { headers: { 'x-forwarded-host': host } })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') ?? '', /text\/html/)
  return r.text()
}
const meta = (h: string, k: string) => h.match(new RegExp(`(?:property|name)="${k}" content="([^"]*)"`))?.[1]

test('the crawler page is a whole html page with og + twitter tags and no scripts', async () => {
  const h = await head('/@ogalice')
  assert.ok(h.startsWith('<!doctype html>') && h.trimEnd().endsWith('</html>'))
  assert.ok(!/<script/i.test(h))
  for (const k of ['og:title', 'og:description', 'og:url', 'og:image', 'og:image:width', 'og:image:height', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) assert.ok(meta(h, k), k)
  assert.equal(meta(h, 'twitter:card'), 'summary_large_image')
  assert.equal(meta(h, 'og:image:width'), '1200'); assert.equal(meta(h, 'og:image:height'), '630')
})

test('profile: name, .wif, escaped bio, canonical url and a profile image', async () => {
  const h = await head('/@ogalice')
  assert.equal(meta(h, 'og:type'), 'profile')
  assert.match(meta(h, 'og:title')!, /alice\.wif/)
  assert.ok(!/<b>/.test(h), 'html in a name is escaped')
  assert.match(h, /Alice &lt;b&gt;&amp;/)
  assert.match(meta(h, 'og:description')!, /makes &quot;calm&quot; things &amp; ships/)
  assert.equal(meta(h, 'og:url'), 'https://app.wifly.fun/@ogalice')
  assert.match(meta(h, 'og:image')!, /^https:\/\/app\.wifly\.fun\/api\/og\/img\/profile\/ogalice\.png\?v=/)
  // plain /handle and followers pages share the profile card
  assert.equal(meta(await head('/ogalice'), 'og:type'), 'profile')
  assert.equal(meta(await head('/@ogalice/followers'), 'og:type'), 'profile')
})

test('post: author + excerpt; paid and supporters-only text never leaks', async () => {
  const h = await head('/post/ogd1')
  assert.equal(meta(h, 'og:type'), 'article')
  assert.match(meta(h, 'og:description')!, /first light on the new card/)
  assert.match(meta(h, 'og:image')!, /\/api\/og\/img\/post\/ogd1\.png/)
  assert.match(meta(await head('/@ogalice/post/ogd1'), 'og:description')!, /first light/)
  for (const id of ['ogd2', 'ogd3']) {
    const g = await head(`/post/${id}`)
    assert.ok(!/secret alpha|members only words/.test(g), `${id} hides its text`)
    assert.match(meta(g, 'og:description')!, /paid drop|supporters/)
  }
  const r = await app.request('http://localhost/api/og/img/post/ogd2.png')
  assert.equal(r.status, 200)
})

test('.wif name page uses the name card', async () => {
  const h = await head('/n/alice')
  assert.match(meta(h, 'og:title')!, /^alice\.wif/)
  assert.match(meta(h, 'og:image')!, /\/api\/og\/img\/name\/alice\.png/)
})

test('unknown, deleted, and app pages fall back to the clean default card', async () => {
  for (const p of ['/', '/explore', '/@nobody-here', '/@oggone', '/post/nope', '/n/zz-not-a-name', '/some/odd/path?x=<script>']) {
    const h = await head(p)
    assert.ok(meta(h, 'og:image'), p)
    assert.ok(!/<script>/.test(h), 'no raw input in tags')
  }
  assert.match(meta(await head('/'), 'og:image')!, /\/api\/og\/img\/default\//)
  assert.match(meta(await head('/@oggone'), 'og:image')!, /\/api\/og\/img\/default\//)
  assert.equal(meta(await head('/'), 'og:title'), meta(await head('/'), 'og:title')!.toLowerCase())
  // untrusted host never becomes the url
  assert.match(meta(await head('/@ogalice', 'evil.example'), 'og:url')!, /^https:\/\/(app\.)?wifly\.fun\//)
})

test('images are 1200x630 pngs for every kind, cached and rate limited', async () => {
  clearOgCache(); resetRateLimits()
  for (const p of ['profile/ogalice', 'post/ogd1', 'name/alice', 'default/home', 'default/explore', 'profile/nobody-here']) {
    const r = await app.request(`http://localhost/api/og/img/${p}.png`)
    assert.equal(r.status, 200, p)
    assert.equal(r.headers.get('content-type'), 'image/png')
    assert.match(r.headers.get('cache-control') ?? '', /max-age/)
    const b = Buffer.from(await r.arrayBuffer())
    assert.equal(b.subarray(1, 4).toString(), 'PNG')
    assert.equal(b.readUInt32BE(16), 1200, p); assert.equal(b.readUInt32BE(20), 630, p)
  }
  assert.equal((await app.request('http://localhost/api/og/img/bogus/x.png')).status, 404)
})

test('template and html injection stays inert: names, bios, posts and paths', async () => {
  const evil = ['{{env "X"}}', '{$VAR}', '`whoami`', '<script>alert(1)</script>', '{{ httpInclude "/etc/passwd" }}']
  const bad = evil.join(' ')
  await run(`INSERT INTO users (address, handle, name, bio, extras, created_at) VALUES ('0x00000000000000000000000000000000000000b1', 'ogevil', ?, ?, '{}', ?)`, [bad.slice(0, 60), bad, now])
  await run(`INSERT INTO drops (id, author_id, text, created_at) VALUES ('ogevil1', (SELECT id FROM users WHERE handle='ogevil'), ?, ?)`, [bad, now])
  const raw = /[{}`<>]/
  const check = (h: string, what: string) => {
    const head = h.slice(h.indexOf('<head>'))
    for (const m of head.matchAll(/content="([^"]*)"|href="([^"]*)"|<title>([^<]*)<\/title>|<h1>([^<]*)<\/h1>|<p>([^<]*)<\/p>/g)) {
      const v = m.slice(1).find(x => x !== undefined) ?? ''
      assert.ok(!raw.test(v), `${what}: raw {{ } \` < > in ${v}`)
    }
    assert.ok(!/<script/i.test(h), `${what}: no script tag`)
    assert.ok(!h.includes('{{') && !h.includes('{$') && !h.includes('`'), `${what}: nothing a template engine could read`)
  }
  const prof = await head('/@ogevil'); check(prof, 'profile')
  assert.equal(meta(prof, 'og:type'), 'profile')
  assert.match(prof, /&#123;&#123;env &quot;X&quot;&#125;&#125;/)
  assert.match(prof, /&lt;script&gt;/)
  const post = await head('/post/ogevil1'); check(post, 'post')
  assert.equal(meta(post, 'og:type'), 'article')
  for (const p of ['/{{env "X"}}', '/{$VAR}', '/`id`', '/<script>alert(1)</script>', '/n/{{env "X"}}', '/@{{env "X"}}', '/post/{{x}}', '/a/b/{{ httpInclude "/x" }}']) {
    const h = await head(p); check(h, p)
    assert.equal(meta(h, 'og:url'), 'https://app.wifly.fun/', `${p}: canonical url never echoes the path`)
  }
  // the png cards for the same text render fine
  clearOgCache(); resetRateLimits()
  for (const p of ['profile/ogevil', 'post/ogevil1']) assert.equal((await app.request(`http://localhost/api/og/img/${p}.png`)).status, 200, p)
})
