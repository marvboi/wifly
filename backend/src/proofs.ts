/**
 * Wallet proofs: a single-use, expiring server nonce signed by one wallet (a signature, never a transaction).
 * Used by "use my .wif" (the wallet that holds a name) and the tip destination (the wallet that receives tips).
 */
import type { Hono } from 'hono'
import { generateSiweNonce } from 'viem/siwe'
import { parseAbi, verifyMessage, type Address, type Hex } from 'viem'
import { chainClient } from './chain'
import { namesContract } from './config'
import { all, db, one, run } from './db'
import { needUser, type Env } from './auth'
import { logEvent, shortAddr, shortId, uidForWallet, walletsOfUser } from './accounts'
import { HANDLE_RE, RESERVED, syncName } from './features'
import { useOwnedName } from './reconcile'
import { fail, rateLimit } from './util'

export type Purpose = 'wif' | 'tips' | 'main'
const TTL = 10 * 60_000
const ADDR = /^0x[0-9a-fA-F]{40}$/
const NS = parseAbi(['function ownerOfName(string) view returns (address)', 'function reverseName(address) view returns (string)', 'function resolve(string) view returns (address)'])
const lc = (s: unknown) => String(s ?? '').toLowerCase()
const parse = (s: string | null | undefined) => { try { return JSON.parse(s || '{}') } catch { return {} } }


const lines: Record<Purpose, string> = {
  wif: 'use the .wif this wallet holds on my wifly account.',
  tips: 'send my wifly tips to this wallet.',
  main: 'make this the main wallet of my wifly account.',
}
/** The exact text the wallet signs. Built by the server and stored with the nonce; the client never supplies it. */
function proofMessage(p: Purpose, handle: string, address: string, nonce: string, exp: number) {
  return `wifly: ${lines[p]}\nthis is a signature, not a transaction: nothing is sent.\n\naccount: @${handle}\nwallet: ${lc(address)}\nnonce: ${nonce}\nexpires: ${new Date(exp).toISOString().toLowerCase()}`
}

export async function issueProof(uid: number, p: Purpose, address: string) {
  if (!ADDR.test(address)) fail(400, 'that isn’t a wallet address')
  const u = await one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', [uid])
  const nonce = generateSiweNonce(), exp = Date.now() + TTL
  const message = proofMessage(p, u?.handle ?? '', address, nonce, exp)
  await run('DELETE FROM wallet_proofs WHERE expires_at < ?', [Date.now() - TTL])
  await run('INSERT INTO wallet_proofs (nonce, user_id, purpose, address, message, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [nonce, uid, p, lc(address), message, exp])
  return { nonce, message, expiresAt: exp }
}

/** Burns the nonce first (single use, even on a bad signature), then checks the signature against the stored message. */
export async function consumeProof(uid: number, p: Purpose, address: string, nonce: string, signature: string): Promise<string> {
  const a = lc(address)
  if (!ADDR.test(a) || typeof nonce !== 'string' || !/^0x[0-9a-fA-F]+$/.test(String(signature))) fail(400, 'sign the request with that wallet first')
  const row = await one<{ message: string }>('SELECT message FROM wallet_proofs WHERE nonce = ? AND user_id = ? AND purpose = ? AND address = ?', [nonce, uid, p, a])
  const burned = await db.execute({ sql: 'UPDATE wallet_proofs SET used_at = ? WHERE nonce = ? AND user_id = ? AND purpose = ? AND address = ? AND used_at IS NULL AND expires_at > ?', args: [Date.now(), nonce, uid, p, a, Date.now()] })
  if (!row || burned.rowsAffected !== 1) fail(400, 'that signature request expired or was used. try again')
  let ok = await verifyMessage({ address: a as Address, message: row!.message, signature: signature as Hex }).catch(() => false)
  if (!ok) ok = await chainClient().verifyMessage({ address: a as Address, message: row!.message, signature: signature as Hex }).catch(() => false) // smart wallets
  if (!ok) fail(401, 'that signature isn’t from this wallet')
  return a
}

async function readNames<T>(fn: 'ownerOfName' | 'reverseName' | 'resolve', arg: string): Promise<T | undefined> {
  const N = namesContract(); if (!N) return undefined
  return chainClient().readContract({ address: N, abi: NS, functionName: fn, args: [arg as never] }).then(v => v as T).catch(() => undefined)
}
const zero = (a: string | undefined) => !a || /^0x0{40}$/i.test(a)

/** Where tips to this account go: the wallet it chose (signed), else where its .wif resolves (if that is one of its wallets), else its main wallet. */
export async function payoutOf(uid: number): Promise<{ address: string | null; via: 'chosen' | 'name' | 'main'; name: string | null; resolves: string | null }> {
  const u = await one<{ address: string | null; extras: string | null }>('SELECT address, extras FROM users WHERE id = ?', [uid])
  if (!u) return { address: null, via: 'main', name: null, resolves: null }
  const ex = parse(u.extras), wallets = await walletsOfUser(uid)
  const name = ex.wifName ? lc(ex.wifName) : null
  const r = name ? await readNames<string>('resolve', `${name}.wif`) : undefined
  const resolves = r && !zero(r) ? lc(r) : null
  if (ex.tipWallet && wallets.has(lc(ex.tipWallet))) return { address: lc(ex.tipWallet), via: 'chosen', name, resolves }
  if (resolves && wallets.has(resolves)) return { address: resolves, via: 'name', name, resolves }
  const main = u.address ? lc(u.address) : ([...wallets][0] ?? null)
  return { address: main, via: 'main', name, resolves }
}

export function registerProofs(app: Hono<Env>, h: { me: (uid: number) => Promise<unknown> }) {
  app.post('/api/wallet/proof', async c => {
    const uid = needUser(c)
    await rateLimit(`proof:${uid}`, 20, 60_000)
    const b = await c.req.json<{ purpose: Purpose; address: string }>().catch(() => ({ purpose: '' as Purpose, address: '' }))
    if (b.purpose !== 'wif' && b.purpose !== 'tips' && b.purpose !== 'main') fail(400, 'unknown request')
    return c.json(await issueProof(uid, b.purpose, String(b.address ?? '')))
  })

  /** "use my .wif": a name bought or held anywhere (opensea included). The wallet signs; the chain decides. */
  app.post('/api/names/use', async c => {
    const uid = needUser(c)
    await rateLimit(`nuse:${uid}`, 10, 60_000)
    if (!namesContract()) fail(403, 'claiming .wif names opens soon')
    const b = await c.req.json<{ address: string; nonce: string; signature: string; name?: string }>().catch(() => ({} as never))
    const a = await consumeProof(uid, 'wif', String(b.address ?? ''), String(b.nonce ?? ''), String(b.signature ?? ''))
    const owner = await uidForWallet(a)
    if (owner && owner !== uid) fail(409, 'that wallet is on another wifly account. sign in with it there, or remove it from that account first')
    let n = lc(b.name).trim().replace(/^@/, '').replace(/\.wif$/, '')
    if (!n) n = lc(await readNames<string>('reverseName', a)).replace(/\.wif$/, '')
    if (!n) fail(404, 'this wallet has no main .wif. type the name it holds')
    if (!HANDLE_RE.test(n) || RESERVED.has(n)) fail(400, 'that isn’t a .wif name')
    const chainOwner = await readNames<string>('ownerOfName', n)
    if (chainOwner === undefined) fail(503, 'couldn’t read the chain just now. try again in a minute')
    if (lc(chainOwner) !== a) fail(409, `this wallet doesn’t hold ${n}.wif onchain`)
    if (!owner) await run(`INSERT INTO user_wallets (address, user_id, kind, created_at) VALUES (?, ?, 'linked', ?) ON CONFLICT(address) DO NOTHING`, [a, uid, Date.now()])
    await syncName(n, { onlyKnown: true }).catch(() => null)
    const r = await useOwnedName(uid, n)
    logEvent(`[names] use u=${shortId(uid)} ${n}.wif wallet=${shortAddr(a)}`)
    return c.json({ ok: true, name: n, handle: r.handle ?? n, me: await h.me(uid) })
  })

  app.get('/api/settings/tips', async c => {
    const uid = needUser(c)
    const wallets = await all<{ address: string; kind: string }>(`SELECT address, 'main' AS kind FROM users WHERE id = ? AND address IS NOT NULL
      UNION SELECT address, kind FROM user_wallets WHERE user_id = ? UNION SELECT wallet AS address, 'privy' AS kind FROM privy_accounts WHERE user_id = ? AND wallet IS NOT NULL`, [uid, uid, uid])
    const seen = new Set<string>(), list: { address: string; kind: string }[] = []
    for (const w of wallets) { const a = lc(w.address); if (a && !seen.has(a)) { seen.add(a); list.push({ address: a, kind: w.kind }) } }
    const p = await payoutOf(uid)
    const log = await all<{ address: string; created_at: number }>('SELECT address, created_at FROM tip_wallet_log WHERE user_id = ? ORDER BY id DESC LIMIT 5', [uid])
    return c.json({ wallets: list, payout: p, changes: log.map(l => ({ address: l.address, at: Number(l.created_at) })) })
  })

  /** Changing where tips go always needs a fresh signature from the wallet that will receive them. Logged. */
  app.post('/api/settings/tips', async c => {
    const uid = needUser(c)
    await rateLimit(`tipw:${uid}`, 10, 60_000)
    const b = await c.req.json<{ address: string; nonce: string; signature: string }>().catch(() => ({} as never))
    const a = await consumeProof(uid, 'tips', String(b.address ?? ''), String(b.nonce ?? ''), String(b.signature ?? ''))
    if (!(await walletsOfUser(uid)).has(a)) fail(400, 'link that wallet to this account first')
    const prev = (await payoutOf(uid)).address
    await run(`UPDATE users SET extras = json_set(COALESCE(extras, '{}'), '$.tipWallet', ?) WHERE id = ?`, [a, uid])
    await run('INSERT INTO tip_wallet_log (user_id, address, prev, created_at) VALUES (?, ?, ?, ?)', [uid, a, prev, Date.now()])
    logEvent(`[tips] destination u=${shortId(uid)} ${shortAddr(prev)} -> ${shortAddr(a)}`)
    return c.json({ ok: true, payout: await payoutOf(uid) })
  })

  /**
   * Make another linked wallet (the Privy one included) the account's main wallet. Needs a fresh signature from that wallet.
   * The old main stays linked (it still signs in). Where tips land doesn't move: if none was chosen, it stays on the old payout wallet.
   */
  app.post('/api/settings/main', async c => {
    const uid = needUser(c)
    await rateLimit(`mainw:${uid}`, 10, 60_000)
    const b = await c.req.json<{ address: string; nonce: string; signature: string }>().catch(() => ({} as never))
    const a = await consumeProof(uid, 'main', String(b.address ?? ''), String(b.nonce ?? ''), String(b.signature ?? ''))
    if (!(await walletsOfUser(uid)).has(a)) fail(400, 'link that wallet to this account first')
    const u = await one<{ address: string | null; extras: string | null }>('SELECT address, extras FROM users WHERE id = ?', [uid])
    const prev = lc(u?.address)
    if (prev === a) return c.json({ ok: true, already: true, me: await h.me(uid) })
    const pay = await payoutOf(uid)
    if (!parse(u?.extras).tipWallet && pay.address && (await walletsOfUser(uid)).has(lc(pay.address)))
      await run(`UPDATE users SET extras = json_set(COALESCE(extras, '{}'), '$.tipWallet', ?) WHERE id = ?`, [lc(pay.address), uid])
    if (prev) await run(`INSERT INTO user_wallets (address, user_id, kind, created_at) VALUES (?, ?, 'linked', ?) ON CONFLICT(address) DO NOTHING`, [prev, uid, Date.now()])
    await run('UPDATE users SET address = ? WHERE id = ?', [a, uid])
    logEvent(`[wallets] main u=${shortId(uid)} ${shortAddr(prev)} -> ${shortAddr(a)}`)
    return c.json({ ok: true, me: await h.me(uid) })
  })

  /** Public: where a tip to @handle lands, so the sender sees it before signing. */
  app.get('/api/users/:handle/payout', async c => {
    const u = await one<{ id: number }>('SELECT id FROM users WHERE handle = ? COLLATE NOCASE AND deleted_at IS NULL', [c.req.param('handle')])
    if (!u) fail(404, 'no one here by that name')
    const p = await payoutOf(Number(u!.id))
    return c.json({ address: p.address, via: p.via, name: p.name })
  })
}
