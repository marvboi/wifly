/** Link-preview avatars: a .webp (or any non-png/jpeg) pfp is converted to png before the card is drawn, so it never renders as
 *  an empty circle; one that won't decode falls back to the lime face; og:image changes when the pfp does. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const dir = mkdtempSync(join(tmpdir(), 'wifly-ogav-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
delete process.env.REDIS_URL; delete process.env.NAMES_CONTRACT_ADDRESS; delete process.env.NAMES_RENDERER_ADDRESS

const { app } = await import('../src/app')
const { migrate, run } = await import('../src/db')
const { clearOgCache, avatarHref } = await import('../src/og')
await migrate()

const webp = readFileSync(new URL('./fixtures/avatar-red.webp', import.meta.url)) // 240x240 red, blue top-left corner
const now = Date.now()
// uploads live in the database (a fresh replica has nothing on disk), so these exist only in the uploads table
await run(`INSERT INTO uploads (name, user_id, data, created_at) VALUES ('ogavtestredpfp.webp', 1, ?, ?)`, [webp, now])
await run(`INSERT INTO uploads (name, user_id, data, created_at) VALUES ('ogavtestbroken.webp', 1, ?, ?)`, [Buffer.from('RIFF....WEBPnot really an image'), now])
await run(`INSERT INTO users (address, handle, name, bio, avatar, created_at) VALUES ('0x00000000000000000000000000000000000000b1', 'ogwebp', 'webp face', '', '/uploads/ogavtestredpfp.webp', ?)`, [now])
await run(`INSERT INTO users (address, handle, name, bio, avatar, created_at) VALUES ('0x00000000000000000000000000000000000000b2', 'ogbroken', 'broken face', '', '/uploads/ogavtestbroken.webp', ?)`, [now])
await run(`INSERT INTO users (address, handle, name, bio, avatar, created_at) VALUES ('0x00000000000000000000000000000000000000b3', 'ognopfp', 'no face', '', NULL, ?)`, [now])

async function card(handle: string) {
  clearOgCache()
  const r = await app.request(`http://localhost/api/og/img/profile/${handle}.png`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/png')
  const { data, info } = await sharp(Buffer.from(await r.arrayBuffer())).raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 1200); assert.equal(info.height, 630)
  return (x: number, y: number) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]] }
}
// the profile card's avatar circle: x 104..340, y 112..348, centre (222, 230)
const near = (px: number[], rgb: number[], tol = 40) => px.every((v, i) => Math.abs(v - rgb[i]) <= tol)

test('a .webp pfp is converted to png and drawn inside the circle (it used to be an empty circle)', async () => {
  const px = await card('ogwebp')
  assert.ok(near(px(222, 250), [0xd6, 0x26, 0x2b]), `centre of the circle is the photo's red, got ${px(222, 250)}`)
  assert.ok(!near(px(222, 250), [255, 255, 255], 10), 'not blank white')
})

test('avatarHref hands the renderer png, sized to 2x the circle', async () => {
  const href = await avatarHref('/uploads/ogavtestredpfp.webp', 84)
  assert.ok(href?.startsWith('data:image/png;base64,'))
  const meta = await sharp(Buffer.from(href!.split(',')[1], 'base64')).metadata()
  assert.equal(meta.format, 'png'); assert.equal(meta.width, 168); assert.equal(meta.height, 168)
})

test('a pfp that will not decode falls back to the lime face, never an empty circle', async () => {
  assert.equal(await avatarHref('/uploads/ogavtestbroken.webp'), null)
  const px = await card('ogbroken')
  assert.ok(near(px(150, 140), [0xcc, 0xff, 0x00]), `lime face drawn, got ${px(150, 140)}`)
})

test('no pfp, a missing upload, or a non-upload url: the lime face', async () => {
  assert.equal(await avatarHref('/uploads/nosuchfile.webp'), null)
  assert.equal(await avatarHref('https://example.com/a.webp'), null)
  assert.equal(await avatarHref('data:image/webp;base64,AAAA'), null)
  const px = await card('ognopfp')
  assert.ok(near(px(150, 140), [0xcc, 0xff, 0x00]), `lime face drawn, got ${px(150, 140)}`)
})

test('og:image is versioned by the avatar: a new pfp gives a new image url', async () => {
  const img = async () => (await (await app.request('http://localhost/api/og/page/@ogwebp', { headers: { 'x-forwarded-host': 'app.wifly.fun' } })).text()).match(/property="og:image" content="([^"]*)"/)?.[1]
  const a = await img()
  assert.match(a ?? '', /\/api\/og\/img\/profile\/ogwebp\.png\?v=[0-9a-f]{10}$/)
  await run(`UPDATE users SET avatar = '/uploads/ogavtestbroken.webp' WHERE handle = 'ogwebp'`)
  clearOgCache()
  const b = await img()
  assert.notEqual(a, b)
})
