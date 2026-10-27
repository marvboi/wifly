// Fails if the Caddyfile's CSP drifts from security-headers.mjs, or if localhost sneaks into the production policy.
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { CADDY_CSP, cspFor, DEFAULT_SITE_ORIGINS, THEME_INIT_HASH } from './security-headers.mjs'
const caddy = readFileSync(new URL('./Caddyfile', import.meta.url), 'utf8')
const m = caddy.match(/Content-Security-Policy "([^"]+)"/)
if (!m || m[1] !== CADDY_CSP) { console.error('Caddyfile CSP is out of date. Expected:\n' + CADDY_CSP); process.exit(1) }
const prod = cspFor(DEFAULT_SITE_ORIGINS)
if (/localhost|127\.0\.0\.1/.test(prod) || /localhost|127\.0\.0\.1/.test(m[1])) { console.error('localhost in the production CSP'); process.exit(1) }
for (const o of DEFAULT_SITE_ORIGINS) if (!m[1].includes(o)) { console.error('missing default origin ' + o); process.exit(1) }
for (const h of ['X-Frame-Options SAMEORIGIN', 'X-Content-Type-Options nosniff']) if (!caddy.includes(h)) { console.error('missing ' + h); process.exit(1) }
// Inline scripts: none may need 'unsafe-inline'; every inline script in the built index.html must be hashed in the CSP.
const scriptSrc = (CADDY_CSP.match(/script-src ([^;]+)/) || [])[1] || ''
if (scriptSrc.includes("'unsafe-inline'")) { console.error("script-src must not allow 'unsafe-inline'"); process.exit(1) }
if (!scriptSrc.includes(THEME_INIT_HASH)) { console.error('theme script hash missing from script-src'); process.exit(1) }
const html = new URL('./dist/index.html', import.meta.url)
if (existsSync(html)) {
  const inline = [...readFileSync(html, 'utf8').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])
  for (const body of inline) {
    const h = `'sha256-${createHash('sha256').update(body).digest('base64')}'`
    if (!scriptSrc.includes(h)) { console.error(`dist/index.html has an inline script whose hash ${h} is not in script-src`); process.exit(1) }
  }
  console.log(`inline scripts ok: ${inline.length} in dist/index.html, all hashed in script-src`)
} else console.log('no dist/index.html yet: built inline scripts not checked (run after npm run build)')
console.log('csp ok')
