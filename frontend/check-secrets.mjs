// Fails if a server-only secret could reach the browser bundle. Run after `vite build`: `npm run check:secrets`.
// 1. No server secret NAMES in the frontend source or build (AGENT_PRIVATE_KEY, ATTESTER_PRIVATE_KEY, PRIVY_APP_SECRET).
// 2. Vite only exposes VITE_* vars, and no VITE_* var looks like a key/secret.
// 3. If the real key is in this process's env (CI / Railway build), its value must not appear in dist. Never printed.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p] })
const files = ['dist', 'src'].filter(existsSync).flatMap(walk).filter(f => /\.(m?js|tsx?|html|map|json|css)$/.test(f))
let bad = 0
const say = m => { console.error('✗ ' + m); bad++ }
for (const f of files) if (/AGENT_PRIVATE_KEY|ATTESTER_PRIVATE_KEY|PRIVY_APP_SECRET/.test(readFileSync(f, 'utf8'))) say(`${f} mentions a server-only secret`)
const vite = readFileSync('vite.config.ts', 'utf8')
if (/envPrefix/.test(vite) && !/envPrefix:\s*['"]VITE_['"]/.test(vite)) say('vite envPrefix must stay VITE_')
for (const f of ['.env', '.env.local', '.env.production', '.env.production.local'].filter(existsSync))
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const k = line.split('=')[0].trim()
    if (/^VITE_.*(PRIVATE|SECRET|MNEMONIC|SEED)/.test(k)) say(`frontend/${f}: ${k} would be bundled; secrets belong in the backend`)
    if (/^(AGENT|ATTESTER)_PRIVATE_KEY$/.test(k)) say(`frontend/${f} holds ${k}; it belongs only in the backend`)
  }
for (const k of ['AGENT_PRIVATE_KEY', 'ATTESTER_PRIVATE_KEY', 'PRIVY_APP_SECRET']) {
  const v = (process.env[k] || '').replace(/^0x/, '').toLowerCase()
  if (v.length >= 16 && existsSync('dist')) for (const f of walk('dist')) if (readFileSync(f, 'utf8').toLowerCase().includes(v)) say(`${f} contains the value of ${k}`)
}
if (bad) { console.error(`${bad} problem(s). Server keys never go in the web app.`); process.exit(1) }
console.log(`secrets ok: ${files.length} frontend files, no agent key or server secret`)
