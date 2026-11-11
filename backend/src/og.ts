/**
 * Link previews. Crawlers (x, telegram, discord, imessage, slack…) get open graph + twitter card tags in the page head
 * (wifly-web's caddy proxies crawler page requests to /api/og/page + the shared path) and a 1200x630 png drawn here.
 * Only public data: paid or supporters-only drops never show their text, deleted accounts and drops fall back to the default card.
 */
import type { Context, Hono } from 'hono'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'
import type { Env } from './auth'
import { ALLOWED_ORIGINS, ROOT, UPLOAD_DIR, namesRendererContract } from './config'
import { one } from './db'
import { hydrateDrops, hydrateUsers } from './hydrate'
import { renderNameSvg, unclaimedPreview } from './names-art'
import { chainClient } from './chain'
import type { Address } from 'viem'
import { Lru } from './lru'
import { clientIp } from './abuse'
import { rateLimit } from './util'

const FONT_DIR = process.env.OG_FONT_DIR || resolve(ROOT, 'assets/fonts')
const FONTS = ['WIFPar-Flat0.ttf', 'Geist-VariableFont_wght.ttf'].map(f => resolve(FONT_DIR, f)).filter(f => existsSync(f))

const INK = '#110E08', MUTED = '#6F6A60', LINE = '#ECE9E2', PAPER = '#F7F5F0', NEON = '#CCFF00'
const SITE_NAME = 'wifly'
const DEFAULT_DESC = 'get paid for what you post. tips, subscriptions and paid drops in $wif, straight to your wallet.'

// the wifly face on its lime tile (same geometry as the app icon) and the logotype, path-only so no font is needed
const FACE = (x: number, y: number, s: number, r = 0.26) => `<g transform="translate(${x} ${y}) scale(${s / 100})"><rect width="100" height="100" rx="${100 * r}" fill="${NEON}"/><g transform="translate(50 50.5) scale(0.62) translate(-50 -52)"><path d="M50 12 C74.1 12 93 31 93 55 C93 79.5 76.5 92 50 92 C23.5 92 7 79.5 7 55 C7 31 25.9 12 50 12 Z" fill="${INK}"/><rect x="32" y="32.75" width="11" height="18.5" rx="5.5" fill="${NEON}"/><rect x="57" y="32.75" width="11" height="18.5" rx="5.5" fill="${NEON}"/><path d="M32.50 60.50 C33.10 67.47 35.73 69.00 41.00 69.00 C46.40 69.00 49.60 65.85 50.00 62.00 C50.40 65.85 53.60 69.00 59.00 69.00 C64.27 69.00 66.90 67.47 67.50 60.50" fill="none" stroke="${NEON}" stroke-width="6.6" stroke-linecap="round" stroke-linejoin="round"/></g></g>`
let logotype: string | null = null
function LOGO(x: number, y: number, h: number) {
  if (logotype === null) {
    const f = [resolve(ROOT, 'assets/wifly-logotype.svg'), resolve(ROOT, '../frontend/public/brand/wifly-logotype.svg')].find(existsSync)
    logotype = f ? readFileSync(f, 'utf8').replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '') : ''
  }
  // viewBox -20 -760 2760 1000
  return logotype ? `<svg x="${x}" y="${y}" width="${h * 2.76}" height="${h}" viewBox="-20 -760 2760 1000">${logotype}</svg>` : `<text x="${x}" y="${y + h * 0.8}" font-family="WIF Par" font-size="${h}" fill="${INK}">wifly</text>`
}

/** Entity-encodes everything that could mean something to html, xml or any template engine in front of us: & < > " ' ` { } */
const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '{': '&#123;', '}': '&#125;' }
export const esc = (s: string) => String(s).replace(/[&<>"'`{}]/g, ch => ENT[ch]!)
/** emoji and control characters have no glyph in our fonts; drop them from the drawn text (tags keep them). */
const drawable = (s: string) => s.replace(/\p{Extended_Pictographic}|[\u200d\ufe0f\u0000-\u001f]/gu, '').replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

/** greedy wrap by an average glyph width; the last line gets an ellipsis when text is left over. */
export function wrap(text: string, size: number, width: number, maxLines: number, em = 0.54): string[] {
  const per = Math.max(4, Math.floor(width / (size * em)))
  const words = drawable(text).split(' ').filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (let w of words) {
    while (w.length > per) { if (cur) { lines.push(cur); cur = '' } lines.push(w.slice(0, per)); w = w.slice(per) }
    if (!cur) cur = w
    else if ((cur + ' ' + w).length <= per) cur += ' ' + w
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  if (lines.length > maxLines) { const keep = lines.slice(0, maxLines); keep[maxLines - 1] = clip(keep[maxLines - 1] + ' ' + lines[maxLines], per).replace(/…?$/, '…'); return keep }
  return lines
}
const tspans = (lines: string[], x: number, lh: number) => lines.map((l, i) => `<tspan x="${x}" dy="${i ? lh : 0}">${esc(l)}</tspan>`).join('')

const frame = (inner: string, footer: string, brand = true) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="${PAPER}"/>
<rect x="40" y="40" width="1120" height="550" rx="40" fill="#FFFFFF" stroke="${LINE}" stroke-width="2"/>
${inner}
${brand ? FACE(88, 500, 52, 0.3) + LOGO(156, 506, 40) : ''}
<text x="1112" y="537" text-anchor="end" font-family="Geist" font-size="26" fill="${MUTED}">${esc(footer)}</text>
</svg>`

/**
 * The avatar as an inline png the card renderer can always draw. resvg only decodes png/jpeg reliably (a .webp pfp drew an
 * empty circle), so every upload is read from disk or, on a replica that hasn't cached it yet, from the uploads table, then
 * converted with sharp to a square png at 2x the circle (cover crop). Anything that won't decode: null (the face is drawn).
 */
const avatarCache = new Lru<string, string>({ max: 200, maxBytes: 24 * 1024 * 1024, size: v => v.length * 2 })
export async function avatarHref(avatar: string | null | undefined, size = 236): Promise<string | null> {
  const m = /^\/uploads\/([A-Za-z0-9_-]+\.(png|jpg|jpeg|gif|webp))$/.exec(avatar ?? '')
  if (!m) return null
  const key = `${m[1]}@${size}`
  const hit = avatarCache.get(key)
  if (hit !== undefined) return hit || null
  let out: string | null = null
  try {
    const f = resolve(UPLOAD_DIR, m[1])
    let buf: Uint8Array | null = existsSync(f) ? readFileSync(f) : null
    if (!buf) { const r = await one<{ data: ArrayBuffer }>('SELECT data FROM uploads WHERE name = ?', [m[1]]); if (r?.data) buf = new Uint8Array(r.data) }
    if (buf && buf.byteLength > 0 && buf.byteLength <= 8 * 1024 * 1024) {
      const px = Math.min(1024, Math.max(64, Math.round(size * 2)))
      const png = await sharp(buf, { limitInputPixels: 50_000_000, animated: false }).rotate().resize(px, px, { fit: 'cover', position: 'attention' }).png().toBuffer()
      out = `data:image/png;base64,${png.toString('base64')}`
    }
  } catch { out = null }
  avatarCache.set(key, out ?? '', out ? undefined : 5 * 60_000) // a miss is retried after a while
  return out
}
/** a round avatar, or the lime wifly face when there is no picture or it won't decode: never an empty circle */
async function avatarBlock(x: number, y: number, s: number, avatar: string | null | undefined, id: string) {
  const href = await avatarHref(avatar, s)
  if (!href) return FACE(x, y, s, 0.5)
  return `<clipPath id="${id}"><circle cx="${x + s / 2}" cy="${y + s / 2}" r="${s / 2}"/></clipPath><image href="${href}" x="${x}" y="${y}" width="${s}" height="${s}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/><circle cx="${x + s / 2}" cy="${y + s / 2}" r="${s / 2 - 1}" fill="none" stroke="${LINE}" stroke-width="2"/>`
}
const pill = (x: number, y: number, label: string) => {
  const w = Math.round(label.length * 15.5 + 40)
  return { w, svg: `<rect x="${x}" y="${y}" width="${w}" height="48" rx="24" fill="${NEON}"/><text x="${x + w / 2}" y="${y + 33}" text-anchor="middle" font-family="WIF Par, Geist" font-size="26" fill="${INK}">${esc(label)}</text>` }
}

// ---------- what a path is ----------
type Profile = { handle: string; name: string; bio: string; avatar: string | null; wifName: string | null }
type Target =
  | { kind: 'profile'; u: Profile }
  | { kind: 'post'; id: string; u: Profile; text: string; gated: boolean; image: boolean }
  | { kind: 'name'; name: string; claimed: boolean; holder: string | null; theme: number }
  | { kind: 'default'; page: string }

const ROUTE = new Set(['home', 'search', 'notifications', 'settings', 'admin', 'api', 'uploads', 'you', 'me', 'welcome', 'login', 'signin', 'signup', 'logout',
  'messages', 'bookmarks', 'vote', 'pay', 'post', 'agent', 'plus', 'names', 'n', 'u', 'pot', 'swap', 'dca', 'deploy', 'docs', 'followers', 'following',
  'onboarding', 'guest', 'link', 'share', 'feed', 'explore', 'trending', 'drops', 'drop', 'status', 'assets', 'brand', 'fonts', 'static', 'favicon', 'manifest',
  'app', 'www', 'landing', 'tip', 'tips', 'wallet', 'auth', 'oauth', 'callback', 'healthz', 'market', 'badges', 'burn', 'about', 'terms', 'privacy', 'help', 'support'])
const HANDLE = /^[a-z0-9_]{1,20}$/

async function profileOf(handle: string): Promise<Profile | null> {
  const r = await one<{ id: number }>("SELECT id FROM users WHERE handle = ? AND deleted_at IS NULL AND handle NOT LIKE '~%'", [handle])
  if (!r) return null
  const u = (await hydrateUsers([Number(r.id)], null)).get(Number(r.id))
  return u ? { handle: u.handle, name: u.name, bio: u.bio ?? '', avatar: u.avatar, wifName: u.wifName ?? null } : null
}

export async function targetOf(rawPath: string): Promise<Target> {
  let path = '/'
  try { path = decodeURIComponent(rawPath.split(/[?#]/)[0] || '/') } catch { /* bad escape: default */ }
  const seg = path.split('/').filter(Boolean)
  const lower = seg.map(s => s.toLowerCase())
  try {
    // /n/name(.wif)
    if (lower[0] === 'n' && lower[1]) {
      const n = lower[1].replace(/\.wif$/, '')
      if (/^[a-z0-9_]{1,32}$/.test(n)) {
        const row = await one<{ owner_id: number; theme: number }>('SELECT owner_id, theme FROM names WHERE name = ?', [n])
        const holder = row ? (await one<{ handle: string }>('SELECT handle FROM users WHERE id = ? AND deleted_at IS NULL', [row.owner_id]))?.handle ?? null : null
        return { kind: 'name', name: n, claimed: !!row, holder: holder && !holder.startsWith('~') ? holder : null, theme: Number(row?.theme ?? 0) }
      }
    }
    // /post/id or /@author/post/id
    const pid = lower[0] === 'post' ? seg[1] : lower[1] === 'post' ? seg[2] : null
    if (pid && /^[A-Za-z0-9_-]{1,64}$/.test(pid)) {
      const d = (await hydrateDrops([pid], null))[0] as (Awaited<ReturnType<typeof hydrateDrops>>[number] & { deleted?: boolean }) | undefined
      const author = d?.author?.handle ? await profileOf(d.author.handle) : null
      if (d && author && (d.text || d.lockedHidden || d.image)) return { kind: 'post', id: pid, u: author, text: d.text ?? '', gated: !!d.lockedHidden, image: !!d.image }
    }
    // /@handle or /handle (+ /followers, /following)
    if (seg[0] && (seg.length === 1 || (seg.length === 2 && (lower[1] === 'followers' || lower[1] === 'following')))) {
      const at = seg[0].startsWith('@')
      const h = (at ? lower[0].slice(1) : lower[0]).replace(/\.wif$/, '')
      if (HANDLE.test(h) && (at || !ROUTE.has(h))) { const u = await profileOf(h); if (u) return { kind: 'profile', u } }
    }
  } catch { /* any read error: the default card */ }
  return { kind: 'default', page: lower[0] ?? '' }
}

// ---------- tags ----------
const PAGE_TITLES: Record<string, [string, string]> = {
  '': ['wifly · get paid for what you post', DEFAULT_DESC],
  home: ['wifly · get paid for what you post', DEFAULT_DESC],
  search: ['explore · wifly', 'find people, drops and .wif names on wifly.'],
  explore: ['explore · wifly', 'find people, drops and .wif names on wifly.'],
  names: ['.wif names · wifly', 'claim a .wif name. it’s yours onchain, and the card is drawn onchain too.'],
  plus: ['wifly plus', 'the plus check, an assistant with no daily limit and more. optional: everything else stays free.'],
  swap: ['get $wif · wifly', 'swap for $wif onchain, right inside wifly.'],
  vote: ['vote · wifly', 'vote on the weekly pot with your $wif.'],
  docs: ['docs · wifly', 'how wifly works: tips, subscriptions, paid drops, .wif names and the weekly pot.'],
}
const OG_RENDER = 2 // bump when the drawing changes, so previews that cached a broken card fetch a new one
const imgVersion = (t: Target) => createHash('sha256').update(OG_RENDER + JSON.stringify(t)).digest('hex').slice(0, 10)

export function originFor(host: string | undefined): string {
  const h = (host ?? '').toLowerCase().replace(/[^a-z0-9.:-]/g, '')
  const hit = ALLOWED_ORIGINS.find(o => { try { return new URL(o).host === h } catch { return false } })
  return hit ?? process.env.PUBLIC_APP_URL ?? ALLOWED_ORIGINS.find(o => o.startsWith('https://')) ?? 'https://app.wifly.fun'
}

function canonicalPath(t: Target): string {
  if (t.kind === 'profile') return `/@${t.u.handle}`
  if (t.kind === 'post') return `/post/${t.id}`
  if (t.kind === 'name') return `/n/${t.name}`
  return t.page && PAGE_TITLES[t.page] ? `/${t.page}` : '/'
}

export function metaFor(t: Target, _path: string, origin: string) {
  let title: string, desc: string, img: string, type = 'website'
  if (t.kind === 'profile') {
    const u = t.u
    title = `${u.name} (${u.wifName ? `${u.wifName}.wif` : `@${u.handle}`}) · ${SITE_NAME}`
    desc = u.bio ? clip(u.bio.replace(/\s+/g, ' '), 200) : `${u.name} is on wifly. tips in $wif go straight to their wallet.`
    img = `/api/og/img/profile/${u.handle}.png`; type = 'profile'
  } else if (t.kind === 'post') {
    title = `${t.u.name} on ${SITE_NAME}`
    desc = t.gated ? 'a paid drop. unlock it on wifly.' : t.text ? `“${clip(t.text.replace(/\s+/g, ' '), 200)}”` : `a drop by @${t.u.handle}`
    img = `/api/og/img/post/${t.id}.png`; type = 'article'
  } else if (t.kind === 'name') {
    title = `${t.name}.wif · ${SITE_NAME}`
    desc = t.claimed ? (t.holder ? `${t.name}.wif is held by @${t.holder}. a .wif name, drawn onchain.` : `${t.name}.wif is taken. a .wif name, drawn onchain.`) : `${t.name}.wif is open. claim it on wifly.`
    img = `/api/og/img/name/${t.name}.png`
  } else {
    ;[title, desc] = PAGE_TITLES[t.page] ?? PAGE_TITLES['']
    img = `/api/og/img/default/${PAGE_TITLES[t.page] ? t.page || 'home' : 'home'}.png`
  }
  // the canonical url is rebuilt from what we found, never echoed from the request path
  const url = origin + canonicalPath(t)
  return { title, desc, url, type, image: `${origin}${img}?v=${imgVersion(t)}`, alt: title }
}

export function headHtml(m: ReturnType<typeof metaFor>): string {
  const tag = (attr: 'property' | 'name', k: string, v: string) => `<meta ${attr}="${k}" content="${esc(v)}" />`
  return [
    tag('property', 'og:site_name', SITE_NAME), tag('property', 'og:type', m.type), tag('property', 'og:title', m.title),
    tag('property', 'og:description', m.desc), tag('property', 'og:url', m.url), tag('property', 'og:image', m.image),
    tag('property', 'og:image:width', '1200'), tag('property', 'og:image:height', '630'), tag('property', 'og:image:type', 'image/png'),
    tag('property', 'og:image:alt', m.alt), tag('name', 'twitter:card', 'summary_large_image'), tag('name', 'twitter:title', m.title),
    tag('name', 'twitter:description', m.desc), tag('name', 'twitter:image', m.image), tag('name', 'twitter:image:alt', m.alt),
    `<link rel="canonical" href="${esc(m.url)}" />`,
  ].join('\n    ')
}

/** The whole page a link crawler gets: tags plus a plain body. No scripts, nothing from the request echoed raw. */
export function previewPage(m: ReturnType<typeof metaFor>): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(m.title)}</title>
    <meta name="description" content="${esc(m.desc)}" />
    ${headHtml(m)}
    <link rel="icon" href="/favicon.svg?v=12.4" type="image/svg+xml" />
  </head>
  <body>
    <h1>${esc(m.title)}</h1>
    <p>${esc(m.desc)}</p>
    <p><a href="${esc(m.url)}">${esc(m.url)}</a></p>
  </body>
</html>
`
}

// ---------- images ----------
async function cardSvg(t: Target): Promise<string> {
  if (t.kind === 'profile') {
    const u = t.u
    const big = /^[a-z0-9 _.\-@'’]*$/i.test(drawable(u.name)) ? 'WIF Par, Geist' : 'Geist'
    const nameLines = wrap(u.name, 68, 640, 1, big.startsWith('WIF') ? 0.66 : 0.56)
    let y = 210
    let s = await avatarBlock(104, 112, 236, u.avatar, 'av')
    s += `<text x="400" y="${y}" font-family="${big}" font-size="68" fill="${INK}">${esc(nameLines[0] ?? '')}</text>`
    y += 64
    if (u.wifName) { const p = pill(400, y - 36, `${u.wifName}.wif`); s += p.svg; s += `<text x="${400 + p.w + 18}" y="${y}" font-family="Geist" font-size="30" fill="${MUTED}">@${esc(u.handle)}</text>` }
    else s += `<text x="400" y="${y}" font-family="Geist" font-size="30" fill="${MUTED}">@${esc(u.handle)}</text>`
    const bio = wrap(u.bio || 'on wifly. tips in $wif go straight to their wallet.', 32, 680, 3)
    s += `<text x="400" y="${y + 70}" font-family="Geist" font-size="32" fill="${u.bio ? INK : MUTED}">${tspans(bio, 400, 44)}</text>`
    return frame(s, `wifly.fun/@${u.handle}`)
  }
  if (t.kind === 'post') {
    const u = t.u
    let s = await avatarBlock(104, 100, 84, u.avatar, 'av')
    s += `<text x="210" y="138" font-family="Geist" font-size="34" font-weight="600" fill="${INK}">${esc(clip(drawable(u.name), 36))}</text>`
    s += `<text x="210" y="178" font-family="Geist" font-size="28" fill="${MUTED}">${esc(u.wifName ? `${u.wifName}.wif` : `@${u.handle}`)}</text>`
    if (t.gated) {
      s += `<rect x="104" y="232" width="992" height="200" rx="28" fill="${PAPER}"/><text x="600" y="320" text-anchor="middle" font-family="WIF Par, Geist" font-size="48" fill="${INK}">a paid drop</text><text x="600" y="372" text-anchor="middle" font-family="Geist" font-size="30" fill="${MUTED}">unlock it on wifly</text>`
    } else {
      const text = t.text || (t.image ? 'shared a picture' : '')
      const size = text.length > 160 ? 38 : text.length > 80 ? 46 : 54
      const lines = wrap(text, size, 990, size === 38 ? 5 : 4)
      s += `<text x="104" y="${250 + size * 0.4}" font-family="Geist" font-size="${size}" fill="${t.text ? INK : MUTED}">${tspans(lines, 104, Math.round(size * 1.3))}</text>`
    }
    return frame(s, `wifly.fun/@${u.handle}`)
  }
  if (t.kind === 'name') {
    const ra = namesRendererContract()
    let art: string
    const given = nameArtSource ? await nameArtSource(t.name) : null
    if (given) art = given
    else try { art = await renderNameSvg(t.name, t.name.length <= 4, false, ra ? async data => (await chainClient().call({ to: ra as Address, data })).data ?? '0x' : undefined, t.theme) }
    catch { art = await renderNameSvg(t.name, t.name.length <= 4, false, undefined, t.theme) }
    if (!t.claimed) art = unclaimedPreview(art)
    const href = `data:image/svg+xml;base64,${Buffer.from(art).toString('base64')}`
    let s = `<image href="${href}" x="100" y="80" width="400" height="400"/>`
    const label = `${t.name}.wif`, fs = Math.max(30, Math.min(66, Math.floor(540 / (label.length * 0.62))))
    s += `<text x="560" y="210" font-family="WIF Par, Geist" font-size="${fs}" fill="${INK}">${esc(label)}</text>`
    const y = 280
    s += `<text x="560" y="${y}" font-family="Geist" font-size="32" fill="${MUTED}">${esc(t.claimed ? (t.holder ? `held by @${t.holder}` : 'taken') : 'open to claim')}</text>`
    s += `<text x="560" y="${y + 50}" font-family="Geist" font-size="28" fill="${MUTED}">a .wif name, drawn onchain</text>`
    return frame(s, `wifly.fun/n/${t.name}`)
  }
  const own = t.page && t.page !== 'home' && PAGE_TITLES[t.page] ? PAGE_TITLES[t.page][1] : null
  let s = FACE(110, 140, 300, 0.26)
  s += LOGO(480, 160, 120)
  const l1 = wrap(own ?? 'get paid for what you post.', 34, 600, 3)
  s += `<text x="486" y="352" font-family="Geist" font-size="34" fill="${INK}">${tspans(l1, 486, 46)}</text>`
  if (!own) s += `<text x="486" y="410" font-family="Geist" font-size="28" fill="${MUTED}">${tspans(wrap('tips, subscriptions and paid drops in $wif, straight to your wallet.', 28, 600, 2), 486, 40)}</text>`
  return frame(s, 'wifly.fun', false)
}

/** tests and previews can hand in the exact svg the chain returned for a name */
let nameArtSource: ((name: string) => Promise<string | null>) | null = null
export function setNameArtSourceForTests(f: typeof nameArtSource) { nameArtSource = f; clearOgCache() }

export function renderPng(svg: string): Buffer {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Geist', sansSerifFamily: 'Geist' }, background: '#FFFFFF' })
  return r.render().asPng()
}

const pngCache = new Lru<string, Buffer>({ max: 300, maxBytes: 64 << 20, size: b => b.length, ttlMs: 10 * 60_000 })
export const clearOgCache = () => pngCache.clear()

export async function ogImage(kind: string, key: string): Promise<{ png: Buffer; found: boolean }> {
  const k = key.replace(/\.png$/i, '')
  let t: Target
  if (kind === 'profile') t = await targetOf(`/@${k}`)
  else if (kind === 'post') t = await targetOf(`/post/${k}`)
  else if (kind === 'name') t = await targetOf(`/n/${k}`)
  else t = { kind: 'default', page: PAGE_TITLES[k] ? k : 'home' }
  const found = t.kind !== 'default' || kind === 'default'
  const ck = imgVersion(t)
  let png = pngCache.get(ck)
  if (!png) { png = renderPng(await cardSvg(t)); pngCache.set(ck, png) }
  return { png, found }
}
export { cardSvg }

export function registerOg(app: Hono<Env>) {
  /**
   * Link previews. wifly-web reverse-proxies page requests from crawler user agents here (/api/og/page + the original path);
   * people never reach it. Built and escaped here, served as-is: no template engine sees it. Never fails: worst case the default card.
   */
  const page = async (c: Context<Env>) => {
    const raw = new URL(c.req.url).pathname.slice('/api/og/page'.length) || '/'
    const path = raw.slice(0, 300)
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host
    let html: string
    try { html = previewPage(metaFor(await targetOf(path), path, originFor(host))) }
    catch { html = previewPage(metaFor({ kind: 'default', page: '' }, '/', originFor(undefined))) }
    c.header('content-type', 'text/html; charset=utf-8')
    c.header('cache-control', 'public, max-age=60')
    return c.body(html)
  }
  app.get('/api/og/page', page)
  app.get('/api/og/page/*', page)
  app.get('/api/og/img/:kind/:key', async c => {
    await rateLimit(`og:${clientIp(c)}`, 120, 60_000)
    const kind = c.req.param('kind'), key = c.req.param('key')
    if (!['profile', 'post', 'name', 'default'].includes(kind) || !/^[A-Za-z0-9_.-]{1,70}$/.test(key)) return c.notFound()
    const { png } = await ogImage(kind, key)
    c.header('content-type', 'image/png')
    c.header('cache-control', 'public, max-age=3600, stale-while-revalidate=86400')
    return c.body(new Uint8Array(png))
  })
}
