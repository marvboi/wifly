import { formerlyOf, redirectFor } from './identity'
import { keeperStatus } from './keeper'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { cached } from './cache'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { compress } from 'hono/compress'
import { HTTPException } from 'hono/http-exception'
import type { Hex } from 'viem'
import { csrf, endSession, needUser, session, startSession, verifySiwe, issueNonce, type Env, type LoginVia } from './auth'
import { ALLOWED_ORIGINS, AVATAR_MAX_BYTES, AVATAR_TOO_BIG, LIMITS, TIP_FEE_BPS, UPLOAD_DIR } from './config'
import { all, one, run } from './db'
import { adoptWalletNames, verifyTip } from './verify'
import { reconcileUser } from './reconcile'
import { registerProofs } from './proofs'
import { audit, failLog, guestWriteGate, isAdmin, isGuestAccount, listAccounts, softDeleteUser, uidForWallet } from './accounts'
import { attestLinkHandle, attesterEnabled, privyEnabled, verifyPrivyAny, verifyPrivyToken, type PrivyIdentity } from './privy'
import { isPendingHandle, needsHandle, pendingHandle } from './pending'
import { hydrateDrops, hydrateUsers, type DropRow, type UserRow } from './hydrate'
import { clearRankCache, followingPage, newSince, rankForYou, type FeedItem } from './rank'
import { capForGuest, clientIp, GUEST_PREVIEW, guestReadGate, hasLink, newAccountCooldown, postGate, signupGate, turnstileSiteKey, turnstileEnabled } from './abuse'
import { charCount, decCursor, encCursor, extractMentions, extractTags, fail, newId, rateLimit } from './util'
import { HANDLE_RE, registerFeatures, setHandle } from './features'
import { registerAgent } from './agent'
import { registerDca } from './dca'
import { registerCompanion } from './companion'
import { registerPrice } from './price'
import { imageSize, sizedName } from './imgsize'
import { errLine } from './errline'

export const app = new Hono<Env>()

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
  console.error(`[api] ${c.req.method} ${c.req.path} 500:`, errLine(err))
  return c.json({ error: 'something broke on our side' }, 500)
})
// API responses are data, never pages: nothing may frame them, run script from them or sniff their type.
app.use('*', async (c, next) => {
  await next()
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
  c.header('X-Frame-Options', 'DENY')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Cross-Origin-Resource-Policy', 'same-site')
})
app.use('/api/*', cors({ origin: ALLOWED_ORIGINS, credentials: true, allowHeaders: ['content-type', 'x-wifly'] }))
const gzip = compress()
app.use('/api/*', (c, next) => (c.req.path.endsWith('/stream') ? next() : gzip(c, next)))
app.use('/api/*', csrf)
app.use('/api/*', session)
app.use('/api/*', failLog)
// guests browse, set up their profile and link; liking, tipping, posting, following, names and the rest need a link
app.use('/api/*', guestWriteGate)
// Logged-out reads are open (feed preview, profiles, the vote pot) but rate-limited per IP.
app.use('/api/*', async (c, next) => { if (c.req.method === 'GET' && !c.get('uid')) await guestReadGate(c); return next() })
// JSON GETs carry a weak ETag; a matching If-None-Match gets a bodyless 304. Responses can differ per viewer, so they
// are private to the browser and always revalidated (no shared caching of signed-in data).
app.use('/api/*', async (c, next) => {
  await next()
  if (c.req.method !== 'GET' || c.res.status !== 200 || c.req.path.endsWith('/stream')) return
  if (!(c.res.headers.get('content-type') ?? '').includes('application/json')) return
  const tag = `W/"${createHash('sha1').update(await c.res.clone().text()).digest('base64url').slice(0, 22)}"`
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'private, no-cache')
  c.header('ETag', tag)
  c.header('Vary', 'Cookie')
  if (c.req.header('if-none-match') === tag) c.res = new Response(null, { status: 304, headers: c.res.headers })
})

const PAGE = LIMITS.pageSize
const now = () => Date.now()

async function userByHandle(handle: string) {
  const u = await one<UserRow>('SELECT * FROM users WHERE handle = ? COLLATE NOCASE', [handle])
  if (!u) fail(404, 'no one here by that name')
  return u!
}
async function dropRow(id: string) {
  const d = await one<DropRow>('SELECT * FROM drops WHERE id = ?', [id])
  if (!d || Number(d.deleted)) fail(404, 'this drop is gone')
  return d!
}
async function me(uid: number) {
  const u = (await hydrateUsers([uid], uid)).get(uid)!
  const r = await one<{ onboarded: number; handle: string; extras: string | null }>('SELECT onboarded, handle, extras FROM users WHERE id = ?', [uid])
  const pending = needsHandle(r)
  const p = await one<{ x_username: string | null }>('SELECT x_username FROM privy_accounts WHERE user_id = ? AND x_username IS NOT NULL ORDER BY updated_at DESC LIMIT 1', [uid])
  const w = await all<{ address: string }>(`SELECT address FROM user_wallets WHERE user_id = ? AND kind = 'linked' ORDER BY created_at`, [uid])
  const privy = await one('SELECT 1 FROM privy_accounts WHERE user_id = ? LIMIT 1', [uid])
  return {
    ...u, handle: isPendingHandle(u.handle) ? '' : u.handle, name: isPendingHandle(u.name) ? '' : u.name, onboarded: !!Number(r?.onboarded) && !pending, needsHandle: pending, renaming: !!Number(r?.onboarded) && pending,
    links: { x: p?.x_username ?? null, wallets: w.map(r => r.address), privy: !!privy },
    guest: await isGuestAccount(uid),
  }
}
async function notify(userId: number, actorId: number, kind: string, dropId: string | null, meta: object = {}) {
  if (userId === actorId) return
  if (kind === 'like' || kind === 'pass' || kind === 'follow')
    await run('DELETE FROM notifications WHERE user_id = ? AND actor_id = ? AND kind = ? AND drop_id IS ?', [userId, actorId, kind, dropId])
  await run('INSERT INTO notifications (user_id, actor_id, kind, drop_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, actorId, kind, dropId, JSON.stringify(meta), now()])
}
async function unnotify(userId: number, actorId: number, kind: string, dropId: string | null) {
  await run('DELETE FROM notifications WHERE user_id = ? AND actor_id = ? AND kind = ? AND drop_id IS ?', [userId, actorId, kind, dropId])
}
async function feedResponse(items: FeedItem[], uid: number | null, next: string | null) {
  const passedBy = new Map(items.filter(i => i.passedBy).map(i => [i.id, i.passedBy!]))
  const why = new Map(items.filter(i => i.why).map(i => [i.id, i.why!]))
  const hyd = await hydrateDrops(items.map(i => i.id), uid, { passedBy })
  // "why am I seeing this" (For you only; the Following tab is chronological and has no reason line)
  return { items: why.size ? hyd.map(d => (why.has(d.id) ? { ...d, why: why.get(d.id) } : d)) : hyd, next }
}

// ---------- config + auth ----------
app.get('/api/config', c => c.json({ limits: LIMITS }))
app.get('/api/health', c => c.json({ ok: true }))
/** Railway health check: answers once the database responds. */
app.get('/healthz', async c => { await one('SELECT 1'); return c.json({ ok: true }) })
/** Same check under /api, so it is reachable through the web proxy (Caddy forwards /api/*). */
app.get('/api/healthz', async c => { await one('SELECT 1'); return c.json({ ok: true }) })
/** Weekly keeper status (public, read only): flag, interval and the last runs. No addresses or keys. */
app.get('/api/vote/keeper', async c => c.json(await keeperStatus()))

app.get('/api/auth/nonce', async c => c.json({ nonce: await issueNonce() }))
app.post('/api/auth/verify', async c => {
  await rateLimit(`auth:${clientIp(c)}`, 20, 60_000)
  const body = await c.req.json<{ message: string; signature: Hex; turnstileToken?: string; website?: string; guest?: boolean }>()
  const address = await verifySiwe(c, body.message, body.signature)
  let u = await userByWallet(address)
  if (!u) {
    await signupGate(c, address, body)
    // no made-up @name: it stays hidden until they pick one in onboarding
    const r = await run('INSERT INTO users (address, handle, name, tone, extras, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [address, pendingHandle(), '', parseInt(address.slice(-2), 16) % 6, body.guest ? '{"guest":1}' : '{}', now()])
    u = { id: Number(r.lastInsertRowid) }
  }
  await reconcileUser(Number(u.id)).catch(() => null)
  await startSession(c, Number(u.id), 'wallet')
  return c.json({ me: await me(Number(u.id)), login: await loginOf(Number(u.id), 'wallet') })
})
/** The account a wallet signs in to: its main address, or a wallet linked to it later. */
async function userByWallet(address: string): Promise<{ id: number } | null> {
  const id = await uidForWallet(address) // main address, linked or guest wallet, or the Privy wallet of an X/email account
  return id ? { id } : null
}
/** A sign-up that never got going (no @name, no posts, no names): safe to fold into the account that's linking it. */
async function isShell(uid: number) {
  const u = await one<{ handle: string; onboarded: number }>('SELECT handle, onboarded FROM users WHERE id = ? AND deleted_at IS NULL', [uid])
  if (!u || Number(u.onboarded) || !isPendingHandle(u.handle)) return false
  return !(await one(`SELECT 1 FROM drops WHERE author_id = ? UNION ALL SELECT 1 FROM names WHERE owner_id = ? UNION ALL SELECT 1 FROM tips WHERE from_id = ? OR to_id = ? LIMIT 1`, [uid, uid, uid, uid]))
}
// Privy: the frontend posts the identity token it got after X/email login. We verify it, then find or create the user.
async function userForPrivy(id: PrivyIdentity, onCreate: () => Promise<unknown> = async () => {}): Promise<number> {
  const linked = await one<{ user_id: number }>('SELECT user_id FROM privy_accounts WHERE did = ?', [id.did])
  const wallet = id.embeddedWallet ?? id.smartWallet // smart wallets are off; embedded EVM wallet first
  let uid = linked ? Number(linked.user_id) : 0
  if (!uid && wallet) {
    // Someone who already signed in with this wallet (SIWE) keeps their account.
    const u = await one<{ id: number }>('SELECT u.id FROM users u LEFT JOIN privy_accounts p ON p.user_id = u.id WHERE u.address = ? AND p.did IS NULL', [wallet])
    if (u) uid = Number(u.id)
  }
  if (!uid && wallet) {
    const u = await one<{ id: number }>('SELECT w.user_id AS id FROM user_wallets w LEFT JOIN privy_accounts p ON p.user_id = w.user_id WHERE w.address = ? AND p.did IS NULL', [wallet])
    if (u) uid = Number(u.id)
  }
  if (!uid && wallet) uid = (await uidForWallet(wallet)) ?? 0 // the wallet already belongs to an account: never a second one
  if (!uid) {
    await onCreate()
    // no made-up @name: the X username is only a suggestion in onboarding
    const name = (id.xName ?? '').slice(0, LIMITS.nameChars)
    const free = wallet && !(await one('SELECT 1 FROM users WHERE address = ?', [wallet]))
    const r = await run('INSERT INTO users (address, handle, name, tone, created_at) VALUES (?, ?, ?, ?, ?)',
      [free ? wallet : null, pendingHandle(), name, parseInt(id.did.slice(-2), 36) % 6 || 0, now()])
    uid = Number(r.lastInsertRowid)
  }
  // one privy login per account: a second privy user reaching this account through its wallet signs in, it doesn't re-link
  const other = await one<{ did: string }>('SELECT did FROM privy_accounts WHERE user_id = ? AND did <> ?', [uid, id.did])
  if (!other) await run(`INSERT INTO privy_accounts (did, user_id, x_user_id, x_username, email, wallet, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(did) DO UPDATE SET x_user_id = excluded.x_user_id, x_username = excluded.x_username, email = excluded.email,
    wallet = excluded.wallet, updated_at = excluded.updated_at`, [id.did, uid, id.xUserId, id.xUsername, id.email, wallet, now()])
  return uid
}

/** What sign-in methods this server can verify. The Privy app id itself comes from VITE_PRIVY_APP_ID in the frontend. */
app.get('/api/auth/config', c => c.json({ privy: privyEnabled(), wallet: true, smartAccounts: true, attester: attesterEnabled(),
  // Public site key only (never the secret). Null = no human check (dev).
  turnstile: turnstileEnabled() ? turnstileSiteKey() : null }))
app.post('/api/auth/privy', async c => {
  await rateLimit(`auth:${clientIp(c)}`, 20, 60_000)
  type PrivyBody = { identityToken?: string; accessToken?: string; turnstileToken?: string; website?: string }
  const b: PrivyBody = await c.req.json<PrivyBody>().catch(() => ({ identityToken: '' }))
  const id = await verifyPrivyAny(b)
  const uid = await userForPrivy(id, () => signupGate(c, id.did, b))
  await reconcileUser(uid).catch(() => null)
  await startSession(c, uid, 'privy')
  return c.json({ me: await me(uid), login: await loginOf(uid, 'privy'), x: id.xUsername ? { username: id.xUsername } : null })
})

// ---------- linking: a guest (or any account) adds X or a wallet and keeps the SAME wifly account ----------
const TAKEN_X = 'that x account already belongs to another wifly account'
const TAKEN_WALLET = 'that wallet already belongs to another wifly account'
/** Attach a verified Privy login (X, email or its wallet) to the signed-in account. Never creates a user. */
app.post('/api/auth/link/privy', async c => {
  const uid = needUser(c)
  await rateLimit(`link:${uid}`, 20, 60_000)
  const b = await c.req.json<{ identityToken?: string; accessToken?: string }>().catch(() => ({}))
  const id = await verifyPrivyAny(b)
  // the same X/email login used once on its own (an empty sign-up) merges into this account instead of a 409
  const shellOf = async (other: number | null | undefined) => { if (other && other !== uid && await isShell(other)) { await softDeleteUser(other, { actor: 'self' }); return true } return false }
  await shellOf(Number((await one<{ user_id: number }>('SELECT user_id FROM privy_accounts WHERE did = ?', [id.did]))?.user_id ?? 0))
  if (id.embeddedWallet ?? id.smartWallet) await shellOf(await uidForWallet((id.embeddedWallet ?? id.smartWallet)!))
  const byDid = await one<{ user_id: number }>('SELECT user_id FROM privy_accounts WHERE did = ?', [id.did])
  if (byDid && Number(byDid.user_id) !== uid) fail(409, id.xUserId ? TAKEN_X : 'that sign-in already belongs to another wifly account')
  const mine = await one<{ did: string }>('SELECT did FROM privy_accounts WHERE user_id = ?', [uid])
  if (mine && mine.did !== id.did) fail(409, 'this account already has a different x or email sign-in linked')
  if (id.xUserId) {
    const byX = await one<{ user_id: number }>('SELECT user_id FROM privy_accounts WHERE x_user_id = ? AND user_id <> ? LIMIT 1', [id.xUserId, uid])
    if (byX) fail(409, TAKEN_X)
  }
  const wallet = id.embeddedWallet ?? id.smartWallet
  if (wallet) {
    const w = await userByWallet(wallet)
    if (w && Number(w.id) !== uid) fail(409, TAKEN_WALLET)
  }
  await run(`INSERT INTO privy_accounts (did, user_id, x_user_id, x_username, email, wallet, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(did) DO UPDATE SET x_user_id = excluded.x_user_id, x_username = excluded.x_username, email = excluded.email,
    wallet = excluded.wallet, updated_at = excluded.updated_at`, [id.did, uid, id.xUserId, id.xUsername, id.email, wallet, now()])
  if (wallet) {
    await run('UPDATE users SET address = ? WHERE id = ? AND address IS NULL', [wallet, uid])
    // the Privy wallet signs in to (and holds names for) this account too, even when the account already had an address
    await run(`INSERT OR IGNORE INTO user_wallets (address, user_id, kind, created_at) VALUES (?, ?, 'privy', ?)`, [wallet, uid, now()])
    await adoptWalletNames(uid, wallet).catch(() => null)
  }
  // the account is owned by this login now; the session follows it
  await startSession(c, uid, 'privy')
  return c.json({ me: await me(uid), login: await loginOf(uid, 'privy') })
})
/** Attach a wallet (SIWE signature) to the signed-in account. A guest's wallet becomes the main one; the guest key still signs in. */
app.post('/api/auth/link/wallet', async c => {
  const uid = needUser(c)
  await rateLimit(`link:${uid}`, 20, 60_000)
  const b = await c.req.json<{ message: string; signature: Hex; guest?: boolean }>()
  const address = await verifySiwe(c, b.message, b.signature)
  let owner = await userByWallet(address)
  if (owner && Number(owner.id) !== uid && await isShell(Number(owner.id))) { await softDeleteUser(Number(owner.id), { actor: 'self' }); owner = null }
  if (owner && Number(owner.id) !== uid) fail(409, TAKEN_WALLET)
  const cur = await one<{ address: string | null }>('SELECT address FROM users WHERE id = ?', [uid])
  if (cur?.address === address) return c.json({ me: await me(uid), login: await loginOf(uid, c.get('via')) })
  const privyWallet = cur?.address ? await one('SELECT 1 FROM privy_accounts WHERE user_id = ? AND wallet = ?', [uid, cur.address]) : null
  if (!cur?.address || (b.guest && !privyWallet)) {
    if (cur?.address) await run(`INSERT OR IGNORE INTO user_wallets (address, user_id, kind, created_at) VALUES (?, ?, 'guest', ?)`, [cur.address, uid, now()])
    await run('UPDATE users SET address = ? WHERE id = ?', [address, uid])
  }
  await run(`INSERT INTO user_wallets (address, user_id, kind, created_at) VALUES (?, ?, 'linked', ?)
    ON CONFLICT(address) DO UPDATE SET kind = 'linked'`, [address, uid, now()])
  await adoptWalletNames(uid, address).catch(() => null)
  await startSession(c, uid, 'wallet')
  return c.json({ me: await me(uid), login: await loginOf(uid, 'wallet') })
})

/** linkHandle attestation for the signed-in user's own X account (numeric id read from the verified Privy token). */
app.post('/api/x/attest', async c => {
  const uid = needUser(c)
  await rateLimit(`attest:${uid}`, 10, 60_000)
  const { identityToken, account } = await c.req.json<{ identityToken: string; account?: string }>().catch(() => ({ identityToken: '', account: undefined }))
  const id = await verifyPrivyToken(identityToken)
  const row = await one<{ user_id: number }>('SELECT user_id FROM privy_accounts WHERE did = ?', [id.did])
  if (!row || Number(row.user_id) !== uid) fail(403, 'that sign-in belongs to another account')
  return c.json(await attestLinkHandle(id, account))
})

/** @handle -> numeric X id, only for people who signed in to Wifly with X (Privy-verified). Otherwise null. */
app.get('/api/x/resolve', async c => {
  const h = (c.req.query('handle') ?? '').trim().replace(/^@/, '').toLowerCase()
  if (!/^[a-z0-9_]{1,15}$/.test(h)) return c.json({ xUserId: null })
  const r = await one<{ x_user_id: string }>('SELECT x_user_id FROM privy_accounts WHERE lower(x_username) = ? AND x_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1', [h])
  return c.json({ xUserId: r?.x_user_id ?? null })
})
app.post('/api/auth/logout', c => { endSession(c); return c.json({ ok: true }) })

// ---------- delete my account (soft) ----------
app.post('/api/me/delete', async c => {
  const uid = needUser(c)
  await rateLimit(`del:${uid}`, 3, 3600_000)
  await rateLimit(`del:${clientIp(c)}`, 10, 3600_000)
  const { confirm } = await c.req.json<{ confirm?: string }>().catch(() => ({ confirm: '' }))
  const u = await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [uid])
  const want = isPendingHandle(u?.handle) ? 'delete' : u!.handle.toLowerCase()
  if (String(confirm ?? '').trim().replace(/^@/, '').toLowerCase() !== want) fail(400, isPendingHandle(u?.handle) ? 'type delete to confirm' : 'type your @name to confirm')
  await softDeleteUser(uid, { actor: 'self' })
  clearRankCache()
  endSession(c)
  return c.json({ ok: true })
})

// ---------- owner-only accounts list (ADMIN_ADDRESSES; empty = off, 404 for everyone) ----------
const needAdmin = async (c: Parameters<typeof needUser>[0]) => { const uid = c.get('uid'); if (!(await isAdmin(uid))) fail(404, 'not found'); return uid! }
app.get('/api/admin/accounts', async c => {
  const admin = await needAdmin(c)
  await rateLimit(`adm:${admin}`, 60, 60_000)
  const f = c.req.query('filter'); const filter = f === 'unfinished' || f === 'guests' ? f : 'all'
  const rows = await listAccounts({ filter })
  await audit(admin, 'list_accounts', null, { filter, n: rows.length })
  return c.json({ accounts: rows })
})
app.post('/api/admin/accounts/:id/remove', async c => {
  const admin = await needAdmin(c)
  await rateLimit(`adm-rm:${admin}`, 20, 3600_000)
  const id = Number(c.req.param('id'))
  const { confirm } = await c.req.json<{ confirm?: string }>().catch(() => ({ confirm: '' }))
  const u = await one<{ handle: string }>('SELECT handle FROM users WHERE id = ? AND deleted_at IS NULL', [id])
  if (!u) fail(404, 'that account is gone')
  if (id === admin) fail(400, 'use delete my account in settings for your own account')
  const typed = String(confirm ?? '').trim().replace(/^@/, '').toLowerCase()
  if (typed !== 'remove' && (isPendingHandle(u!.handle) || typed !== u!.handle.toLowerCase())) fail(400, 'type the @name or remove to confirm')
  await softDeleteUser(id, { actor: 'admin', adminUid: admin })
  await audit(admin, 'remove_account', id)
  clearRankCache()
  return c.json({ ok: true })
})

// ---------- landing: one real featured post (FEATURED_POST_ID env or the admin 'landing:featured' setting) ----------
export const DEFAULT_FEATURED_POST = '88stVCX0GF'
const FEATURED_RE = /^[A-Za-z0-9_-]{4,32}$/
async function featuredId(): Promise<string> {
  const kv = await one<{ v: string }>("SELECT v FROM kv WHERE k = 'landing:featured'").catch(() => null)
  const id = kv?.v || process.env.FEATURED_POST_ID || DEFAULT_FEATURED_POST
  return FEATURED_RE.test(id) ? id : DEFAULT_FEATURED_POST
}
/** Public, cached 30s. Only plain public posts: no locked, supporters-only, deleted, reply or seed posts. 404 otherwise, and the landing hides the card. */
app.get('/api/landing/featured', async c => {
  const id = await featuredId()
  const out = await cached(['drop'], `landing:${id}`, 30_000, async () => {
    const row = await one<DropRow>('SELECT * FROM drops WHERE id = ? AND deleted = 0', [id])
    if (!row) return null
    const [d] = await hydrateDrops([row.id], null)
    if (!d || d.deleted || d.locked || d.supportersOnly || d.replyTo || d.seed || !d.author || d.author.seed) return null
    return { id: d.id, text: d.text, likes: d.likes, tipped: d.tipped, createdAt: d.createdAt, author: { handle: d.author.handle, name: d.author.name, avatar: d.author.avatar } }
  })
  if (!out) fail(404, 'no featured post')
  c.header('Cache-Control', 'public, max-age=30')
  return c.json({ featured: out })
})
app.post('/api/admin/landing', async c => {
  const admin = await needAdmin(c)
  await rateLimit(`adm-land:${admin}`, 20, 3600_000)
  const { featured } = await c.req.json<{ featured?: string | null }>().catch(() => ({ featured: undefined }))
  if (featured === null || featured === '') await run("DELETE FROM kv WHERE k = 'landing:featured'")
  else if (typeof featured === 'string' && FEATURED_RE.test(featured) && await one('SELECT id FROM drops WHERE id = ? AND deleted = 0', [featured]))
    await run("INSERT INTO kv (k, v) VALUES ('landing:featured', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [featured])
  else fail(400, 'that post is not there')
  await audit(admin, 'set_landing_featured', null, { featured: featured || null })
  return c.json({ featured: await featuredId() })
})

/** Which sign-in this session used, for settings ("signed in with wallet 0x12…ab"). Null for older sessions. */
export type Login = { method: 'wallet'; address: string | null } | { method: 'x'; username: string } | { method: 'email' } | { method: 'privy' }
async function loginOf(uid: number, via: LoginVia | null): Promise<Login | null> {
  if (via === 'wallet') return { method: 'wallet', address: (await one<{ address: string | null }>('SELECT address FROM users WHERE id = ?', [uid]))?.address ?? null }
  if (via !== 'privy') return null
  const p = await one<{ x_username: string | null; email: string | null }>('SELECT x_username, email FROM privy_accounts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [uid])
  return p?.x_username ? { method: 'x', username: p.x_username } : p?.email ? { method: 'email' } : { method: 'privy' }
}
app.get('/api/me', async c => {
  const uid = c.get('uid')
  if (!uid) return c.json({ me: null })
  const unread = await one<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', [uid])
  return c.json({ me: await me(uid), unread: Number(unread?.n ?? 0), login: await loginOf(uid, c.get('via')), ...((await isAdmin(uid)) ? { admin: true } : {}) })
})
app.patch('/api/me', async c => {
  const uid = needUser(c)
  const b = await c.req.json<{ handle?: string; name?: string; bio?: string; avatar?: string | null; location?: string }>()
  const sets: string[] = [], args: (string | null)[] = []
  if (b.handle !== undefined) await setHandle(uid, String(b.handle))
  if (b.name !== undefined) {
    const n = String(b.name).trim()
    if (!n || charCount(n) > LIMITS.nameChars) fail(400, `names are 1–${LIMITS.nameChars} characters`)
    sets.push('name = ?'); args.push(n)
  }
  if (b.bio !== undefined) {
    const s = String(b.bio).trim()
    if (charCount(s) > LIMITS.bioChars) fail(400, `bios are up to ${LIMITS.bioChars} characters`)
    sets.push('bio = ?'); args.push(s)
  }
  if (b.location !== undefined) { sets.push('location = ?'); args.push(String(b.location).trim().slice(0, 40) || null) }
  if (b.avatar !== undefined) {
    if (b.avatar !== null && !(await isOwnUpload(b.avatar))) fail(400, 'avatar must be an uploaded image')
    sets.push('avatar = ?'); args.push(b.avatar)
  }
  if (b.handle !== undefined) sets.push(`extras = json_set(COALESCE(extras, '{}'), '$.handlePicked', 1)`)
  const picked = b.handle !== undefined || !needsHandle(await one<{ handle: string; extras: string | null }>('SELECT handle, extras FROM users WHERE id = ?', [uid]))
  if (sets.length) await run(`UPDATE users SET ${[...sets, ...(picked ? ['onboarded = 1'] : [])].join(', ')} WHERE id = ?`, [...args, uid])
  return c.json({ me: await me(uid) })
})

// ---------- uploads ----------
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  return null
}
async function isOwnUpload(url: unknown): Promise<boolean> {
  if (typeof url !== 'string' || !/^\/uploads\/[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/.test(url)) return false
  return existsSync(resolve(UPLOAD_DIR, url.slice(9))) || !!(await one('SELECT 1 FROM uploads WHERE name = ?', [url.slice(9)]))
}
app.post('/api/uploads', async c => {
  const uid = needUser(c)
  await rateLimit(`up:${uid}`, 30, 10 * 60_000)
  // ?kind=avatar: profile photos, up to 20 MB. Everything else (post media): 5 MB.
  const avatar = c.req.query('kind') === 'avatar'
  const max = avatar ? AVATAR_MAX_BYTES : LIMITS.imageBytes
  const tooBig = avatar ? AVATAR_TOO_BIG : 'images up to 5 MB'
  const len = Number(c.req.header('content-length') || 0)
  if (len > max + 64_000) fail(413, tooBig)
  const form = await c.req.formData()
  const f = form.get('file')
  if (!(f instanceof File)) fail(400, 'attach a file')
  const file = f as File
  if (file.size > max) fail(413, tooBig)
  const buf = new Uint8Array(await file.arrayBuffer())
  const ext = sniff(buf)
  if (!ext) fail(415, 'png, jpg, gif or webp only')
  await mkdir(UPLOAD_DIR, { recursive: true })
  // the pixel size rides in the name so feeds can reserve the image box before it loads (no layout shift)
  const name = sizedName(newId(16), ext!, imageSize(buf))
  await run('INSERT INTO uploads (name, user_id, data, created_at) VALUES (?, ?, ?, ?)', [name, uid, buf, now()])
  await writeFile(resolve(UPLOAD_DIR, name), buf).catch(() => {})
  return c.json({ url: `/uploads/${name}` })
})

// ---------- drops ----------
app.post('/api/drops', async c => {
  const uid = needUser(c)
  await postGate(c, uid)
  const b = await c.req.json<{ text?: string; image?: string | null; replyTo?: string | null; quoteOf?: string | null; locked?: { price: number; teaser: string } | null; supportersOnly?: string | null }>()
  const text = String(b.text ?? '').replace(/\r\n/g, '\n').trim()
  if (charCount(text) > LIMITS.dropChars) fail(400, `drops are up to ${LIMITS.dropChars} characters`)
  if (b.image && !(await isOwnUpload(b.image))) fail(400, 'image must be uploaded first')
  if (!text && !b.image && !b.quoteOf) fail(400, 'say something first')
  if (hasLink(text) || hasLink(String(b.locked?.teaser ?? ''))) await newAccountCooldown(uid, 'links')
  let parent: DropRow | null = null, quoted: DropRow | null = null
  if (b.replyTo) parent = await dropRow(String(b.replyTo))
  if (b.quoteOf) quoted = await dropRow(String(b.quoteOf))
  // Paid drops: a locked drop (one-time unlock in WIF) or supporters-only (any of your tiers). Top-level drops only.
  let locked: string | null = null, supporters: string | null = null
  if (b.locked || b.supportersOnly) {
    if (parent || quoted) fail(400, 'replies and quotes can’t be locked')
    if (!text) fail(400, 'write the drop that gets unlocked')
    if (b.locked && b.supportersOnly) fail(400, 'pick one: an unlock price or supporters only')
  }
  if (b.locked) {
    const price = Number(b.locked.price), teaser = String(b.locked.teaser ?? '').trim()
    if (!Number.isFinite(price) || price < 1 || price > 1e7) fail(400, 'unlock prices are 1 to 10,000,000 WIF')
    if (!teaser || charCount(teaser) > 140) fail(400, 'add a teaser, up to 140 characters')
    locked = JSON.stringify({ price: Math.round(price * 100) / 100, teaser, unlocks: 0 })
  }
  if (b.supportersOnly) {
    const tiers = JSON.parse((await one<{ extras: string }>('SELECT extras FROM users WHERE id = ?', [uid]))?.extras || '{}').tiers as { id: string }[] | undefined
    if (!tiers?.length) fail(400, 'set up a subscription tier first')
    if (!tiers!.some(t => t.id === b.supportersOnly)) fail(400, 'pick one of your tiers')
    supporters = String(b.supportersOnly)
  }
  const id = newId()
  const t = now()
  await run(`INSERT INTO drops (id, author_id, text, image, locked, supporters_only, reply_to, root_id, quote_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, uid, text, b.image ?? null, locked, supporters, parent?.id ?? null, parent ? (parent.root_id ?? parent.id) : null, quoted?.id ?? null, t])
  for (const tag of extractTags(text)) await run('INSERT OR IGNORE INTO tags (drop_id, tag, created_at) VALUES (?, ?, ?)', [id, tag, t])
  if (parent) {
    await run('UPDATE drops SET reply_count = reply_count + 1 WHERE id = ?', [parent.id])
    await notify(Number(parent.author_id), uid, 'reply', id, { parent: parent.id })
  }
  if (quoted) {
    await run('UPDATE drops SET quote_count = quote_count + 1 WHERE id = ?', [quoted.id])
    await notify(Number(quoted.author_id), uid, 'quote', id, { quoted: quoted.id })
  }
  for (const h of extractMentions(text)) {
    const m = await one<{ id: number }>('SELECT id FROM users WHERE handle = ? COLLATE NOCASE', [h])
    if (m && Number(m.id) !== Number(parent?.author_id)) await notify(Number(m.id), uid, 'mention', id)
  }
  clearRankCache()
  return c.json({ drop: (await hydrateDrops([id], uid))[0] }, 201)
})

app.get('/api/drops/:id', async c => {
  const uid = c.get('uid')
  return c.json(await cached(['drop'], `d:${uid ?? 0}:${c.req.param('id')}`, 10_000, () => threadOf(c.req.param('id'), uid)))
})
async function threadOf(id: string, uid: number | null) {
  const row = await one<DropRow>('SELECT * FROM drops WHERE id = ?', [id])
  if (!row) fail(404, 'this drop is gone')
  // Walk up the reply chain (max 20) for context.
  const chain: string[] = []
  let cur = row!.reply_to
  while (cur && chain.length < 20) {
    chain.unshift(cur)
    cur = (await one<{ reply_to: string | null }>('SELECT reply_to FROM drops WHERE id = ?', [cur]))?.reply_to ?? null
  }
  const [drop] = await hydrateDrops([row!.id], uid)
  return { drop, ancestors: await hydrateDrops(chain, uid), ...(await repliesPage(row!.id, uid, null)) }
}

/** Replies: your own first, then by people you follow, then best (likes, replies, tips) with a recency nudge. */
async function repliesPage(id: string, uid: number | null, cursor: number | null) {
  const off = cursor ?? 0
  const rows = await all<{ id: string }>(`
    SELECT d.id FROM drops d WHERE d.reply_to = ? AND d.deleted = 0
      AND d.author_id NOT IN (SELECT target_id FROM mutes WHERE user_id = ?)
    ORDER BY (d.author_id = ?) DESC,
      (d.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)) DESC,
      (d.like_count + 2 * d.reply_count + d.tip_total / 25.0) DESC, d.created_at DESC
    LIMIT ? OFFSET ?`, [id, uid ?? 0, uid ?? 0, uid ?? 0, PAGE + 1, off])
  const more = rows.length > PAGE
  return { replies: await hydrateDrops(rows.slice(0, PAGE).map(r => r.id), uid), next: more ? encCursor(off + PAGE) : null }
}
app.get('/api/drops/:id/replies', async c => {
  const uid = c.get('uid')
  if (!uid && c.req.query('cursor')) return c.json({ replies: [], next: null, guest: { limit: 0, more: true } })
  const r = await repliesPage(c.req.param('id'), uid, decCursor<number>(c.req.query('cursor')))
  if (uid) return c.json(r)
  return c.json({ ...r, replies: r.replies.slice(0, GUEST_PREVIEW), next: null, guest: { limit: GUEST_PREVIEW, more: r.replies.length > GUEST_PREVIEW || !!r.next } })
})

app.delete('/api/drops/:id', async c => {
  const uid = needUser(c)
  const d = await dropRow(c.req.param('id'))
  if (Number(d.author_id) !== uid) fail(403, 'you can only delete your own drops')
  await run('UPDATE drops SET deleted = 1 WHERE id = ?', [d.id])
  await run('DELETE FROM tags WHERE drop_id = ?', [d.id])
  await run('DELETE FROM notifications WHERE drop_id = ?', [d.id])
  if (d.reply_to) await run('UPDATE drops SET reply_count = MAX(0, reply_count - 1) WHERE id = ?', [d.reply_to])
  if (d.quote_of) await run('UPDATE drops SET quote_count = MAX(0, quote_count - 1) WHERE id = ?', [d.quote_of])
  clearRankCache()
  return c.json({ ok: true })
})

/** like / pass / bookmark share one shape: idempotent on and off, return the server's truth for reconciling. */
const toggles = {
  like: { table: 'likes', col: 'like_count', notif: 'like' },
  pass: { table: 'passes', col: 'pass_count', notif: 'pass' },
  bookmark: { table: 'bookmarks', col: 'bookmark_count', notif: null },
} as const
for (const [name, t] of Object.entries(toggles)) {
  const handler = (on: boolean) => async (c: any) => {
    const uid = needUser(c)
    await rateLimit(`t:${uid}`, 300, 60_000)
    const d = await dropRow(c.req.param('id'))
    const r = on
      ? await run(`INSERT OR IGNORE INTO ${t.table} (user_id, drop_id, created_at) VALUES (?, ?, ?)`, [uid, d.id, now()])
      : await run(`DELETE FROM ${t.table} WHERE user_id = ? AND drop_id = ?`, [uid, d.id])
    if (r.rowsAffected) {
      await run(`UPDATE drops SET ${t.col} = MAX(0, ${t.col} + ?) WHERE id = ?`, [on ? 1 : -1, d.id])
      if (t.notif) on ? await notify(Number(d.author_id), uid, t.notif, d.id) : await unnotify(Number(d.author_id), uid, t.notif, d.id)
    }
    const [drop] = await hydrateDrops([d.id], uid)
    return c.json({ drop })
  }
  app.post(`/api/drops/:id/${name}`, handler(true))
  app.delete(`/api/drops/:id/${name}`, handler(false))
}

app.post('/api/drops/:id/not-interested', async c => {
  const uid = needUser(c)
  const d = await dropRow(c.req.param('id'))
  await run('INSERT OR IGNORE INTO not_interested (user_id, drop_id, created_at) VALUES (?, ?, ?)', [uid, d.id, now()])
  clearRankCache()
  return c.json({ ok: true })
})
app.delete('/api/drops/:id/not-interested', async c => {
  const uid = needUser(c)
  await run('DELETE FROM not_interested WHERE user_id = ? AND drop_id = ?', [uid, c.req.param('id')])
  clearRankCache()
  return c.json({ ok: true })
})

/**
 * Tips are on-chain. This records one so the creator gets a notification.
 * Without a confirmed tx hash it is stored as a preview and does NOT change the public tip total.
 * When TX is on, an indexer should verify tx_hash against the Wifly contract before setting verified = 1.
 */
app.post('/api/drops/:id/tips', async c => {
  const uid = needUser(c)
  await rateLimit(`tip:${uid}`, 60, 60_000)
  await newAccountCooldown(uid, 'tips')
  const d = await dropRow(c.req.param('id'))
  const { amount, txHash } = await c.req.json<{ amount: number; txHash?: string }>()
  const a = Number(amount)
  if (!Number.isFinite(a) || a <= 0 || a > 1e9) fail(400, 'bad amount')
  if (txHash !== undefined && !/^0x[0-9a-f]{64}$/i.test(String(txHash))) fail(400, 'bad tx hash')
  await run('INSERT INTO tips (from_id, to_id, drop_id, amount, tx_hash, verified, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [uid, d.author_id, d.id, a, txHash ? txHash.toLowerCase() : null, now()])
  // Tips go straight to the creator's wallet (Wifly._tip: safeTransfer(creator, amount - fee)); the TIP_FEE_BPS fee is split per FEE_SPLIT (90% pot, 10% burned).
  await notify(Number(d.author_id), uid, 'tip', d.id, { amount: a - a * TIP_FEE_BPS / 10_000, gross: a, preview: !txHash })
  // read the receipt now; if it isn't mined yet the verifier sweep (verify.ts) picks it up
  let verified = false
  if (txHash) {
    const row = await one<{ id: number }>('SELECT id FROM tips WHERE from_id = ? AND tx_hash = ? ORDER BY id DESC LIMIT 1', [uid, txHash.toLowerCase()])
    if (row) verified = await verifyTip(Number(row.id)).catch(() => false)
    if (verified) clearRankCache()
  }
  return c.json({ ok: true, preview: !txHash, verified })
})

// ---------- feeds ----------
app.get('/api/feed', async c => {
  const uid = c.get('uid')
  const tab = c.req.query('tab') ?? 'foryou'
  // hot read: a few seconds per viewer, tab and cursor; any write retires it
  return c.json(await cached(['feed'], `feed:${uid ?? 0}:${tab}:${c.req.query('cursor') ?? ''}`, FEED_TTL, () => feedPage(uid, tab, c.req.query('cursor'))))
})
type Uid = Env['Variables']['uid']
const FEED_TTL = Number(process.env.FEED_CACHE_MS || 10_000)
async function feedPage(uid: Uid, tab: string, cursor: string | undefined): Promise<object> {
  const c = { req: { query: (k: string) => (k === 'cursor' ? cursor : undefined) }, json: <T,>(v: T) => v }
  // Guests get the first page preview only (see capForGuest).
  if (!uid && c.req.query('cursor')) return c.json({ items: [], next: null, guest: { limit: 0, more: true } })
  if (tab === 'following') {
    if (!uid) return c.json({ items: [], next: null, signedOut: true })
    const cur = decCursor<{ ts: number; id: string }>(c.req.query('cursor'))
    const { items, next } = await followingPage(uid, cur, PAGE)
    return c.json({ ...(await feedResponse(items, uid, next ? encCursor(next) : null)), snapshot: cur ? undefined : now() })
  }
  if (tab === 'crowd') {
    const off = decCursor<number>(c.req.query('cursor')) ?? 0
    const rows = await all<{ id: string }>(`SELECT id FROM drops WHERE deleted = 0 AND reply_to IS NULL AND created_at > ? AND vote_count > 0
      AND author_id NOT IN (SELECT target_id FROM mutes WHERE user_id = ?) ORDER BY vote_count DESC, created_at DESC LIMIT ? OFFSET ?`,
      [now() - 7 * 86400_000, uid ?? 0, PAGE + 1, off])
    return c.json(capForGuest(await feedResponse(rows.slice(0, PAGE).map(r => ({ id: r.id })), uid, rows.length > PAGE ? encCursor(off + PAGE) : null), uid))
  }
  const cur = decCursor<{ s: number; o: number }>(c.req.query('cursor')) ?? { s: now(), o: 0 }
  const ranked = await rankForYou(uid, cur.s)
  const page = ranked.slice(cur.o, cur.o + PAGE)
  const next = cur.o + PAGE < ranked.length ? encCursor({ s: cur.s, o: cur.o + PAGE }) : null
  return c.json({ ...capForGuest(await feedResponse(page, uid, next), uid), snapshot: cur.s })
}
app.get('/api/feed/new', async c => {
  const since = Number(c.req.query('since') || 0)
  if (!since) fail(400, 'since is required')
  return c.json(await newSince(c.get('uid'), c.req.query('tab') ?? 'foryou', since))
})

app.get('/api/bookmarks', async c => {
  const uid = needUser(c)
  const off = decCursor<number>(c.req.query('cursor')) ?? 0
  const rows = await all<{ drop_id: string }>(`SELECT b.drop_id FROM bookmarks b JOIN drops d ON d.id = b.drop_id
    WHERE b.user_id = ? AND d.deleted = 0 ORDER BY b.created_at DESC LIMIT ? OFFSET ?`, [uid, PAGE + 1, off])
  return c.json(await feedResponse(rows.slice(0, PAGE).map(r => ({ id: r.drop_id })), uid, rows.length > PAGE ? encCursor(off + PAGE) : null))
})

// ---------- people ----------
app.get('/api/users/:handle', async c => {
  const h = c.req.param('handle').replace(/^@/, '').replace(/\.wif$/i, '')
  const uid = c.get('uid')
  return c.json(await cached(['users'], `u:${uid ?? 0}:${h.toLowerCase()}`, 15_000, async () => {
    const found = await one<UserRow>('SELECT * FROM users WHERE handle = ? COLLATE NOCASE', [h])
    // nobody is public before they pick a name
    const u = found && isPendingHandle(found.handle) && Number(found.id) !== uid ? null : found
    if (!u) {
      // Old @links follow you to your new name until the old name is sold or claimed.
      const to = await redirectFor(h)
      if (to) return { redirect: to }
      return fail(404, 'no one here by that name')
    }
    return { user: (await hydrateUsers([Number(u.id)], uid)).get(Number(u.id)), formerly: await formerlyOf(Number(u.id)) }
  }))
})
app.get('/api/users/:handle/drops', async c => {
  const uid = c.get('uid')
  const tab = c.req.query('tab') ?? 'drops'
  if (!uid && c.req.query('cursor')) return c.json({ items: [], next: null, guest: { limit: 0, more: true } })
  const h = c.req.param('handle'), cursor = c.req.query('cursor')
  return c.json(await cached(['feed'], `ud:${uid ?? 0}:${h.toLowerCase()}:${tab}:${cursor ?? ''}`, 10_000, () => userDrops(uid, h, tab, cursor)))
})
async function userDrops(uid: number | null, handle: string, tab: string, cursor: string | undefined) {
  const u = await userByHandle(handle)
  const c = { req: { query: (k: string) => (k === 'cursor' ? cursor : undefined) } }
  const off = decCursor<number>(c.req.query('cursor')) ?? 0
  let rows: { id: string; passer?: string | null; ts?: number }[]
  if (tab === 'likes') {
    rows = await all(`SELECT d.id FROM likes l JOIN drops d ON d.id = l.drop_id WHERE l.user_id = ? AND d.deleted = 0 ORDER BY l.created_at DESC LIMIT ? OFFSET ?`, [u.id, PAGE + 1, off])
  } else if (tab === 'replies') {
    rows = await all(`SELECT id FROM drops WHERE author_id = ? AND deleted = 0 AND reply_to IS NOT NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`, [u.id, PAGE + 1, off])
  } else if (tab === 'media') {
    rows = await all(`SELECT id FROM drops WHERE author_id = ? AND deleted = 0 AND (image IS NOT NULL OR media IS NOT NULL) ORDER BY created_at DESC LIMIT ? OFFSET ?`, [u.id, PAGE + 1, off])
  } else {
    // Their drops plus what they passed on, newest first.
    rows = await all(`SELECT * FROM (
        SELECT id, NULL AS passer, created_at AS ts FROM drops WHERE author_id = ?1 AND deleted = 0 AND reply_to IS NULL
        UNION ALL SELECT p.drop_id, ?2, p.created_at FROM passes p JOIN drops d ON d.id = p.drop_id WHERE p.user_id = ?1 AND d.deleted = 0
      ) ORDER BY ts DESC LIMIT ?3 OFFSET ?4`, [u.id, u.handle, PAGE + 1, off])
  }
  const items: FeedItem[] = rows.slice(0, PAGE).map(r => ({ id: r.id, passedBy: r.passer ? { handle: r.passer, at: Number(r.ts) } : undefined }))
  return capForGuest(await feedResponse(items, uid, rows.length > PAGE ? encCursor(off + PAGE) : null), uid)
}
app.get('/api/users/:handle/:list{followers|following}', async c => {
  const u = await userByHandle(c.req.param('handle'))
  const followers = c.req.param('list') === 'followers'
  const rows = await all<{ id: number }>(followers
    ? 'SELECT follower_id AS id FROM follows WHERE followee_id = ? ORDER BY created_at DESC LIMIT 100'
    : 'SELECT followee_id AS id FROM follows WHERE follower_id = ? ORDER BY created_at DESC LIMIT 100', [u.id])
  const map = await hydrateUsers(rows.map(r => Number(r.id)), c.get('uid'))
  return c.json({ users: rows.map(r => map.get(Number(r.id))).filter(Boolean) })
})
for (const [path, table, cols] of [['follow', 'follows', ['follower_id', 'followee_id']], ['mute', 'mutes', ['user_id', 'target_id']]] as const) {
  app.post(`/api/users/:handle/${path}`, async c => {
    const uid = needUser(c)
    await rateLimit(`f:${uid}`, 200, 60_000)
    const u = await userByHandle(c.req.param('handle'))
    if (Number(u.id) === uid) fail(400, `you cannot ${path} yourself`)
    const r = await run(`INSERT OR IGNORE INTO ${table} (${cols[0]}, ${cols[1]}, created_at) VALUES (?, ?, ?)`, [uid, u.id, now()])
    if (r.rowsAffected && path === 'follow') await notify(Number(u.id), uid, 'follow', null)
    if (path === 'mute') await run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', [uid, u.id])
    clearRankCache()
    return c.json({ user: (await hydrateUsers([Number(u.id)], uid)).get(Number(u.id)) })
  })
  app.delete(`/api/users/:handle/${path}`, async c => {
    const uid = needUser(c)
    const u = await userByHandle(c.req.param('handle'))
    await run(`DELETE FROM ${table} WHERE ${cols[0]} = ? AND ${cols[1]} = ?`, [uid, u.id])
    if (path === 'follow') await unnotify(Number(u.id), uid, 'follow', null)
    clearRankCache()
    return c.json({ user: (await hydrateUsers([Number(u.id)], uid)).get(Number(u.id)) })
  })
}

/**
 * Who to follow: people followed by people you follow (2.0 each), people whose drops you engage with,
 * people who post about the tags you like, people who follow you, plus a small popularity prior.
 */
app.get('/api/suggest/users', async c => {
  const uid = c.get('uid')
  const limit = Math.min(Number(c.req.query('limit') || 3), 20)
  const v = uid ?? 0
  const rows = await all<{ id: number; mutual: number; inter: number; fy: number; pop: number; via: string | null }>(`
    SELECT u.id,
      (SELECT COUNT(*) FROM follows a JOIN follows b ON b.follower_id = a.followee_id WHERE a.follower_id = ?1 AND b.followee_id = u.id) AS mutual,
      (SELECT COUNT(*) FROM likes l JOIN drops d ON d.id = l.drop_id WHERE l.user_id = ?1 AND d.author_id = u.id) AS inter,
      EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND followee_id = ?1) AS fy,
      (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) + COALESCE(json_extract(u.extras, '$.baseFollowers'), 0) AS pop,
      (SELECT x.handle FROM follows a JOIN follows b ON b.follower_id = a.followee_id JOIN users x ON x.id = a.followee_id
         WHERE a.follower_id = ?1 AND b.followee_id = u.id LIMIT 1) AS via
    FROM users u
    WHERE u.id <> ?1 AND u.onboarded = 1
      AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ?1)
      AND u.id NOT IN (SELECT target_id FROM mutes WHERE user_id = ?1)`, [v])
  // Tag overlap with what you like.
  const myTags = new Map<string, number>()
  if (uid) for (const r of await all<{ tag: string; n: number }>('SELECT t.tag, COUNT(*) AS n FROM likes l JOIN tags t ON t.drop_id = l.drop_id WHERE l.user_id = ? GROUP BY t.tag', [uid])) myTags.set(r.tag, Number(r.n))
  const theirTags = new Map<number, Map<string, number>>()
  for (const r of await all<{ a: number; tag: string; n: number }>('SELECT d.author_id AS a, t.tag, COUNT(*) AS n FROM tags t JOIN drops d ON d.id = t.drop_id WHERE d.deleted = 0 GROUP BY d.author_id, t.tag')) {
    const m = theirTags.get(Number(r.a)) ?? new Map(); m.set(r.tag, Number(r.n)); theirTags.set(Number(r.a), m)
  }
  const scored = rows.map(r => {
    const tt = theirTags.get(Number(r.id)) ?? new Map<string, number>()
    let overlap = 0, topTag = ''
    let topV = 0
    for (const [t, n] of tt) { const s = (myTags.get(t) ?? 0) * Math.log1p(n); overlap += s; if (s > topV) { topV = s; topTag = t } }
    const score = 2 * Number(r.mutual) + Math.log1p(Number(r.inter)) + 1.5 * Math.log1p(overlap) + (Number(r.fy) ? 1.5 : 0) + 0.3 * Math.log1p(Number(r.pop))
    const reason = Number(r.fy) ? 'follows you'
      : Number(r.mutual) && r.via ? (Number(r.mutual) > 1 ? `followed by @${r.via} and ${Number(r.mutual) - 1} more` : `followed by @${r.via}`)
      : topTag ? `posts about #${topTag}` : 'popular on wifly'
    return { id: Number(r.id), score, reason }
  }).sort((a, b) => b.score - a.score).slice(0, limit)
  const users = await hydrateUsers(scored.map(s => s.id), uid)
  return c.json({ users: scored.map(s => ({ ...users.get(s.id)!, reason: s.reason })) })
})

/** Active creators: people who posted in the last 14 days, ranked by likes on those drops, then by how much they posted.
 *  Real activity only (no follower padding). Used by the vote list and search. */
app.get('/api/creators', async c => {
  const uid = c.get('uid')
  const limit = Math.min(Math.max(Number(c.req.query('limit') || 8), 1), 30)
  // the vote leaderboard and search both read this; cached per viewer for 15s, retired by any drop/like/follow
  return c.json(await cached(['creators'], `cr:${uid ?? 0}:${limit}`, 15_000, async () => {
  const since = now() - 14 * 86400_000
  const rows = await all<{ id: number; drops: number; likes: number }>(`
    SELECT d.author_id AS id, COUNT(DISTINCT d.id) AS drops, COUNT(l.drop_id) AS likes
    FROM drops d JOIN users u ON u.id = d.author_id LEFT JOIN likes l ON l.drop_id = d.id
    WHERE d.deleted = 0 AND d.created_at > ?1 AND u.onboarded = 1 AND d.author_id <> ?2
    GROUP BY d.author_id ORDER BY likes DESC, drops DESC LIMIT ?3`, [since, uid ?? 0, limit])
  const users = await hydrateUsers(rows.map(r => Number(r.id)), uid)
  return { users: rows.filter(r => users.has(Number(r.id))).map(r => ({ ...users.get(Number(r.id))!, drops: Number(r.drops), likesRecent: Number(r.likes) })) }
  }))
})

/** Trending: tags used by at least 2 people in the last 48h, each use decayed with a 12h half-life. */
app.get('/api/trending', async c => {
  const t = now()
  const rows = await all<{ tag: string; at: number; author: number }>(`SELECT t.tag, t.created_at AS at, d.author_id AS author FROM tags t JOIN drops d ON d.id = t.drop_id
    WHERE t.created_at > ? AND d.deleted = 0`, [t - 48 * 3600_000])
  const agg = new Map<string, { score: number; drops: number; authors: Set<number> }>()
  for (const r of rows) {
    const a = agg.get(r.tag) ?? { score: 0, drops: 0, authors: new Set<number>() }
    a.score += Math.pow(0.5, (t - Number(r.at)) / (12 * 3600_000)); a.drops++; a.authors.add(Number(r.author))
    agg.set(r.tag, a)
  }
  const tags = [...agg.entries()].filter(([, a]) => a.authors.size >= 2)
    .map(([tag, a]) => ({ tag, drops: a.drops, people: a.authors.size, score: a.score * Math.log2(1 + a.authors.size) }))
    .sort((a, b) => b.score - a.score).slice(0, Math.min(Number(c.req.query('limit') || 6), 20))
  return c.json({ tags })
})

// ---------- search ----------
function ftsQuery(q: string) {
  const words = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  return words.slice(0, 8).map(w => `"${w}"*`).join(' ')
}
app.get('/api/search', async c => {
  const uid = c.get('uid')
  const q = (c.req.query('q') ?? '').trim().slice(0, 100)
  const type = c.req.query('type') ?? 'top'
  const off = decCursor<number>(c.req.query('cursor')) ?? 0
  if (!q) return c.json({ users: [], tags: [], drops: [], next: null })
  const out: { users: unknown[]; tags: unknown[]; drops: unknown[]; next: string | null } = { users: [], tags: [], drops: [], next: null }
  const bare = q.replace(/^[@#]/, '')
  if (type === 'top' || type === 'people') {
    const like = `%${bare.replace(/[%_]/g, m => '\\' + m)}%`
    const lim = type === 'people' ? PAGE : 3
    const rows = await all<{ id: number }>(`SELECT id FROM users WHERE onboarded = 1 AND (handle LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\' OR bio LIKE ?1 ESCAPE '\\')
      ORDER BY (handle LIKE ?2 ESCAPE '\\') DESC, (name LIKE ?2 ESCAPE '\\') DESC,
        (SELECT COUNT(*) FROM follows WHERE followee_id = users.id) + COALESCE(json_extract(extras, '$.baseFollowers'), 0) DESC
      LIMIT ?3 OFFSET ?4`, [like, `${bare}%`, lim + 1, type === 'people' ? off : 0])
    const map = await hydrateUsers(rows.slice(0, lim).map(r => Number(r.id)), uid)
    out.users = rows.slice(0, lim).map(r => map.get(Number(r.id)))
    if (type === 'people' && rows.length > lim) out.next = encCursor(off + lim)
  }
  if (type === 'top' || type === 'tags') {
    out.tags = (await all<{ tag: string; n: number }>(`SELECT tag, COUNT(*) AS n FROM tags WHERE tag LIKE ? GROUP BY tag ORDER BY n DESC LIMIT ?`,
      [`${bare.toLowerCase()}%`, type === 'tags' ? 30 : 5])).map(r => ({ tag: r.tag, drops: Number(r.n) }))
  }
  if (type === 'top' || type === 'drops') {
    let rows: { id: string }[]
    if (q.startsWith('#')) {
      rows = await all(`SELECT d.id FROM tags t JOIN drops d ON d.id = t.drop_id WHERE t.tag = ? AND d.deleted = 0
        ORDER BY (d.like_count + 2 * d.reply_count + 2 * d.pass_count) * 1.0 / (1 + (? - d.created_at) / 3600000.0) DESC LIMIT ? OFFSET ?`,
        [bare.toLowerCase(), now(), PAGE + 1, off])
    } else {
      const fq = ftsQuery(q)
      rows = fq ? await all<{ id: string }>(`SELECT d.id FROM drops_fts f JOIN drops d ON d.rowid = f.rowid WHERE drops_fts MATCH ? AND d.deleted = 0
        ORDER BY bm25(drops_fts) - 0.3 * ln(1 + d.like_count) LIMIT ? OFFSET ?`, [fq, PAGE + 1, off]).catch(() => []) : []
    }
    out.drops = await hydrateDrops(rows.slice(0, PAGE).map(r => r.id), uid)
    if (rows.length > PAGE) out.next = encCursor(off + PAGE)
  }
  return c.json(out)
})

// ---------- notifications ----------
type NRow = { id: number; actor_id: number | null; kind: string; drop_id: string | null; meta: string; read: number; created_at: number }
/** Likes and passes on the same drop collapse into one row ("Juno and 4 others liked your drop"). */
app.get('/api/notifications', async c => {
  const uid = needUser(c)
  const before = Number(decCursor<number>(c.req.query('cursor')) ?? Number.MAX_SAFE_INTEGER)
  const rows = await all<NRow>('SELECT * FROM notifications WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 120', [uid, before])
  type G = { key: string; kind: string; actorIds: number[]; count: number; dropId: string | null; meta: any; read: boolean; createdAt: number }
  const groups: G[] = []
  const idx = new Map<string, G>()
  for (const r of rows) {
    const groupable = r.kind === 'like' || r.kind === 'pass'
    const key = groupable ? `${r.kind}:${r.drop_id}:${Number(r.read) ? 'r' : 'u'}` : `n${r.id}`
    let g = idx.get(key)
    if (!g) { g = { key, kind: r.kind, actorIds: [], count: 0, dropId: r.drop_id, meta: JSON.parse(r.meta || '{}'), read: !!Number(r.read), createdAt: Number(r.created_at) }; idx.set(key, g); groups.push(g) }
    g.count++
    if (r.actor_id && g.actorIds.length < 5) g.actorIds.push(Number(r.actor_id))
  }
  const users = await hydrateUsers(groups.flatMap(g => g.actorIds), uid)
  const drops = new Map((await hydrateDrops(groups.map(g => g.dropId).filter((x): x is string => !!x), uid)).map(d => [d.id, d]))
  const last = rows[rows.length - 1]
  return c.json({
    items: groups.map(g => ({ id: g.key, kind: g.kind, actors: g.actorIds.map(a => users.get(a)).filter(Boolean), count: g.count, drop: g.dropId ? drops.get(g.dropId) ?? null : null, meta: g.meta, read: g.read, createdAt: g.createdAt })),
    next: rows.length === 120 && last ? encCursor(Number(last.created_at)) : null,
  })
})
app.post('/api/notifications/read', async c => {
  const uid = needUser(c)
  await run('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0', [uid])
  return c.json({ ok: true })
})

registerFeatures(app, { me, notify })
registerProofs(app, { me })
registerAgent(app)
registerDca(app)
registerCompanion(app)
registerPrice(app)
