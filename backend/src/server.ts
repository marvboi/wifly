import './loadEnv'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { app } from './app'
import { PORT, ROOT, UPLOAD_DIR } from './config'
import { migrate, one } from './db'
import { startWeekKeeper } from './keeper'
import { startDcaKeeper } from './dca'
import { startVerifier } from './verify'
import { runStartupMaintenance } from './maint'
import { reconcileAll } from './reconcile'
import { warmPrice } from './price'
import { store } from './cache'
import { errLine } from './errline'

// speed.12: never let a stray rejection take the process down quietly
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', errLine(e)))
process.on('uncaughtException', (e) => console.error('[uncaughtException]', errLine(e)))

await migrate()
// one-time data maintenance (marker in maint_runs), before the server listens
await runStartupMaintenance().catch(e => console.error('[maint] failed:', errLine(e)))
// .wif holders get their @name; reserved handles without a .wif go back to the name step
await reconcileAll().catch(e => console.error('[reconcile] failed:', errLine(e)))
// No demo seeding: an empty database stays empty until real people sign up.

app.use('/uploads/*', async (c, next) => { await next(); c.header('Cache-Control', 'public, max-age=31536000, immutable'); c.header('X-Content-Type-Options', 'nosniff') })
// Uploads are stored in the database; a replica that hasn't seen one yet pulls it into its disk cache first.
app.use('/uploads/*', async (c, next) => {
  const name = c.req.path.slice(9)
  if (/^[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/.test(name) && !existsSync(resolve(UPLOAD_DIR, name))) {
    const r = await one<{ data: ArrayBuffer }>('SELECT data FROM uploads WHERE name = ?', [name])
    if (r) { await mkdir(UPLOAD_DIR, { recursive: true }); await writeFile(resolve(UPLOAD_DIR, name), new Uint8Array(r.data)) }
  }
  await next()
})
app.use('/uploads/*', serveStatic({ root: relative(process.cwd(), ROOT) || '.', rewriteRequestPath: p => p }))

serve({ fetch: app.fetch, port: PORT }, i => {
  console.log(`wifly api on http://localhost:${i.port}`)
  console.log(`[cache] using ${store.kind}`)
})
// take the cold price read now so no visitor waits on the chain for it
warmPrice()
// Weekly keeper (finalizeEpoch). Off unless WEEK_KEEPER_ENABLED=true.
startWeekKeeper()
// DCA keeper (execute due plans). Off unless DCA_KEEPER_ENABLED=true.
startDcaKeeper()
// Pending-row verifier: reads receipts / ownerOf for tips, badge burns and .wif names. Read-only, no key.
startVerifier()
