/** the companion agent on recorded-style glm + openrouter replies (no real keys, no network): tool calls, streamed replies,
 * timeouts and the whole-answer budget, fallback order glm > gemma > nemotron, calm lowercase errors, free models only. `npm test` */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const dir = mkdtempSync(join(tmpdir(), 'wifly-llmagent-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'; process.env.SIGNUP_PER_IP_HOUR = '1000'
for (const k of ['NAMES_CONTRACT_ADDRESS', 'BADGES_CONTRACT_ADDRESS', 'WIFLY_CONTRACT_ADDRESS', 'DCA_CONTRACT_ADDRESS', 'REDIS_URL', 'AGENT_PRIVATE_KEY', 'AGENT_TX_ENABLED', 'OPENROUTER_API_KEY', 'ZAI_API_KEY', 'FREE_AI_MSGS_PER_DAY', 'AI_ANSWER_BUDGET_MS']) delete process.env[k]
process.env.AI_MODELS = 'google/gemma-4-31b-it:free,nvidia/nemotron-3.5-super-vl:free'

const { app } = await import('../src/app')
const { migrate, db } = await import('../src/db')
const { resetRateLimits } = await import('../src/util')
const { calm } = await import('../src/companion')
const { setLlmProvider, OpenRouter, ZaiGlm, LlmChain, LlmBusy, aiModels, normCalls, ZAI_ENDPOINT } = await import('../src/llm')
const { clearPlusGateCache } = await import('../src/plusGate')

const GEMMA = 'google/gemma-4-31b-it:free', NEMO = 'nvidia/nemotron-3.5-super-vl:free'
type Hit = { who: string; body: any }
const msg = (m: object) => new Response(JSON.stringify({ choices: [{ message: m }] }), { status: 200, headers: { 'content-type': 'application/json' } })
const sse = (chunks: object[]) => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
const hang = (init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
function fake(answer: (who: string, body: any, init: RequestInit, n: number) => Response | Promise<Response>) {
  const hits: Hit[] = []
  const f = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); const who = String(u) === ZAI_ENDPOINT ? 'glm' : body.model
    hits.push({ who, body }); return answer(who, body, init, hits.length)
  }) as unknown as typeof fetch
  return { f, hits }
}
const chainOf = (f: typeof fetch, zaiMs = 20_000) => new LlmChain([new ZaiGlm('zk-test', f, zaiMs), new OpenRouter('or-test', aiModels(), f)])
const user = [{ role: 'user' as const, content: 'hi' }]
const TOOLS = [{ type: 'function' as const, function: { name: 'get_pot', description: 'pot', parameters: { type: 'object', properties: {} } } }]

test('the env list is exactly the two free models, in order', () => assert.deepEqual(aiModels(), [GEMMA, NEMO]))

test('fallback order: glm, then gemma, then nemotron; each asked once, free ids only', async () => {
  const { f, hits } = fake(who => who === NEMO ? msg({ content: 'from nemotron' }) : new Response('{}', { status: 429 }))
  const r = await chainOf(f).chat(user, TOOLS)
  assert.equal(r.content, 'from nemotron'); assert.equal(r.model, NEMO)
  assert.deepEqual(hits.map(h => h.who), ['glm', GEMMA, NEMO])
  assert.equal(hits[0].body.model, 'glm-4.7-flash')
  assert.ok(hits.slice(1).every(h => h.body.model.endsWith(':free')))
  assert.ok(hits.every(h => h.body.stream === false), 'we ask for one json reply, not a stream')
})

test('glm tool call in its own shape (object args, no id) comes out as a clean openai tool call', async () => {
  const { f } = fake(() => msg({ content: null, tool_calls: [{ function: { name: 'get_pot', arguments: {} } }, { function: { arguments: '{}' } }] }))
  const r = await chainOf(f).chat(user, TOOLS)
  assert.deepEqual(r.toolCalls, [{ id: 'call_0', type: 'function', function: { name: 'get_pot', arguments: '{}' } }], 'nameless call dropped, id filled in')
  assert.deepEqual(normCalls([{ id: 'x', function: { name: 'a', arguments: { to: '@juno', amount: 5 } } }])[0].function.arguments, '{"to":"@juno","amount":5}')
})

test('a provider that streams anyway is stitched back together (text and tool call deltas)', async () => {
  const { f } = fake(who => who === 'glm'
    ? sse([{ choices: [{ delta: { content: 'the pot ' } }] }, { choices: [{ delta: { content: 'is open.' } }] }])
    : msg({ content: 'x' }))
  assert.equal((await chainOf(f).chat(user, [])).content, 'the pot is open.')
  const { f: g } = fake(who => who === 'glm' ? new Response('{}', { status: 503 }) : sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_', arguments: '{"a"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'pot', arguments: ':1}' } }] } }] },
  ]))
  const r = await chainOf(g).chat(user, TOOLS)
  assert.equal(r.model, GEMMA); assert.deepEqual(r.toolCalls, [{ id: 'c1', type: 'function', function: { name: 'get_pot', arguments: '{"a":1}' } }])
  const { f: h } = fake(who => who === 'glm' ? sse([{ error: { code: 429 } }]) : msg({ content: 'from gemma' }))
  assert.equal((await chainOf(h).chat(user, [])).content, 'from gemma', 'an error inside a stream falls back too')
})

test('no tools key on the last round (free models reject an empty list)', async () => {
  const { f, hits } = fake(who => who === 'glm' ? new Response('{}', { status: 429 }) : msg({ content: 'ok' }))
  await chainOf(f).chat(user, [])
  assert.ok(hits.every(h => !('tools' in h.body) && !('tool_choice' in h.body)))
})

test('timeouts: a hung glm hands over; a hung everything stops at the answer budget and says busy', async () => {
  const { f } = fake((who, _b, init) => who === 'glm' ? hang(init) : msg({ content: 'from gemma' }))
  assert.equal((await chainOf(f, 60).chat(user, [])).content, 'from gemma')
  const { f: g, hits } = fake((_w, _b, init) => hang(init))
  const t0 = Date.now()
  await assert.rejects(chainOf(g).chat(user, [], { deadline: Date.now() + 150 }), LlmBusy)
  assert.ok(Date.now() - t0 < 1000, `stopped in ${Date.now() - t0}ms`)
  assert.equal(hits.length, 1, 'no new request once the budget is gone')
})

test('a paid model never gets a request, even if AI_MODELS lists one', async () => {
  process.env.AI_MODELS = `openai/gpt-5,${GEMMA},anthropic/claude-x,openrouter/auto,${NEMO}`
  assert.deepEqual(aiModels(), [GEMMA, NEMO])
  const { f, hits } = fake(() => new Response('{}', { status: 429 }))
  await assert.rejects(new OpenRouter('k', ['openai/gpt-5', 'openrouter/auto', GEMMA], f).chat(user, []), LlmBusy)
  assert.deepEqual(hits.map(h => h.body.model), [GEMMA])
  process.env.AI_MODELS = `${GEMMA},${NEMO}`
})

test('calm(): model capitals become lowercase (wifly plus too), tickers lowercase (11.8.8), handles, links and addresses stay', () => {
  assert.equal(calm('Sure! I can do that. You have 50 WIF.'), 'sure! i can do that. you have 50 wif.')
  assert.equal(calm('Swap 0.01 ETH to $WIF, a DCA via AI. WIFLY OK'), 'swap 0.01 eth to $wif, a dca via ai. WIFLY OK')
  assert.equal(calm('Get Wifly Plus. Plus is Great.'), 'get wifly plus. plus is great.')
  assert.equal(calm('Tip @Juno at 0xAbC1 via https://x.com/AbC'), 'tip @Juno at 0xAbC1 via https://x.com/AbC')
})

// end to end through /api/companion/chat with the real provider chain and fake http
type Res = { status: number; body: any; cookie?: string }
async function call(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { host: 'localhost:5173', 'x-wifly': '1' }
  if (opts.cookie) headers.cookie = opts.cookie
  let body: BodyInit | undefined
  if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body) }
  const r = await app.request(`http://localhost:5173${path}`, { method, headers, body })
  const set = r.headers.get('set-cookie')
  return { status: r.status, body: await r.json().catch(() => null), cookie: set ? set.split(';')[0] : undefined }
}
async function plusUser() {
  const acct = privateKeyToAccount(generatePrivateKey())
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'Sign in to Wifly. No transaction, no fee.', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const r = await call('POST', '/api/auth/verify', { body: { message, signature: await acct.signMessage({ message }) } })
  await call('PATCH', '/api/me', { body: { handle: 't' + acct.address.slice(2, 14).toLowerCase() }, cookie: r.cookie })
  const id = Number((await db.execute({ sql: 'SELECT id FROM users WHERE address = ?', args: [acct.address.toLowerCase()] })).rows[0]?.id)
  await db.execute({ sql: `INSERT INTO plus_subs (user_id, expires_at, plan, updated_at) VALUES (?, ?, 'month', ?)`, args: [id, Date.now() + 30 * 86400_000, Date.now()] })
  clearPlusGateCache()
  return r.cookie!
}
before(async () => { await migrate() })
after(() => { setLlmProvider(undefined); db.close(); rmSync(dir, { recursive: true, force: true }) })

test('companion: glm asks for a tool, glm then gets busy, gemma finishes; reply is calm lowercase', async () => {
  resetRateLimits()
  const { f, hits } = fake((who, body) => {
    if (who === 'glm' && !body.messages.some((m: any) => m.role === 'tool')) return msg({ content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'get_pot', arguments: '{}' } }] })
    if (who === 'glm') return new Response('{"error":{"code":"1302"}}', { status: 429 })
    return msg({ content: 'The Pot is open this week. Tip a creator to join!' })
  })
  setLlmProvider(chainOf(f))
  const cookie = await plusUser()
  const r = await call('POST', '/api/companion/chat', { cookie, body: { text: 'give me one fun idea for my next post' } })
  assert.equal(r.status, 200); assert.equal(r.body.reply, 'the pot is open this week. tip a creator to join!'); assert.equal(r.body.model, GEMMA)
  assert.deepEqual(hits.map(h => h.who), ['glm', 'glm', GEMMA])
  const round2 = hits[2].body.messages
  assert.ok(round2.some((m: any) => m.role === 'tool' && m.tool_call_id === 'g1'), 'the tool result goes back with its call id')
  assert.ok(!JSON.stringify(hits.map(h => h.body)).match(/zk-test|or-test/), 'keys only in headers, never in prompts')
  assert.ok(!/robinhood/i.test(JSON.stringify(hits.map(h => h.body))), 'no robinhood name in the system prompt, facts, tool list or tool results')
})

test('companion errors are calm and lowercase', async () => {
  resetRateLimits()
  const cookie = await plusUser()
  setLlmProvider(chainOf(fake(() => new Response('{}', { status: 429 })).f))
  const busy = await call('POST', '/api/companion/chat', { cookie, body: { text: 'tell me a story about frogs' } })
  assert.equal(busy.body.busy, true); assert.match(busy.body.reply, /^the agent is resting, try again in a bit\./)
  setLlmProvider(chainOf(fake(() => new Response('{}', { status: 401 })).f))
  const bad = await call('POST', '/api/companion/chat', { cookie, body: { text: 'tell me a story about cats' } })
  assert.equal(bad.body.reply, 'i couldn’t think that through just now. try again in a moment.')
  for (const t of [busy.body.reply, bad.body.reply]) assert.equal(t.replace(/WIF|ETH/g, ''), t.replace(/WIF|ETH/g, '').toLowerCase())
})

// guests and limits on the agent chat (server side, not just the ui)
async function guestUser() {
  const acct = privateKeyToAccount(generatePrivateKey())
  const { body: { nonce } } = await call('GET', '/api/auth/nonce')
  const message = createSiweMessage({ domain: 'localhost:5173', address: acct.address, statement: 'Sign in to Wifly. No transaction, no fee.', uri: 'http://localhost:5173', version: '1', chainId: 4663, nonce })
  const r = await call('POST', '/api/auth/verify', { body: { message, signature: await acct.signMessage({ message }), guest: true } })
  assert.equal(r.status, 200); assert.equal(r.body.me.guest, true)
  return r.cookie!
}

test('a guest gets a clean 403 link_required from the agent chat and dca parse; the model is never asked', async () => {
  resetRateLimits()
  const { f, hits } = fake(() => msg({ content: 'hello' }))
  setLlmProvider(chainOf(f))
  const cookie = await guestUser()
  for (const [path, body] of [['/api/companion/chat', { text: 'tell me about the pot?' }], ['/api/dca/parse', { text: 'buy $5 of WIF every monday' }]] as const) {
    const r = await call('POST', path, { cookie, body })
    assert.equal(r.status, 403, path); assert.equal(r.body.code, 'link_required', path)
    assert.equal(r.body.error, r.body.error.toLowerCase())
  }
  assert.equal(hits.length, 0, 'no model call for a guest')
})

test('a linked (wallet) user chats fine', async () => {
  resetRateLimits()
  setLlmProvider(chainOf(fake(() => msg({ content: 'Sure, here you go.' })).f))
  const r = await call('POST', '/api/companion/chat', { cookie: await plusUser(), body: { text: 'what is one fun idea for today?' } })
  assert.equal(r.status, 200); assert.equal(r.body.reply, 'sure, here you go.')
})

test('agent chat limits: per user per 10 minutes, per day, and per ip, env-tuned, calm 429 chat_limit', async () => {
  setLlmProvider(chainOf(fake(() => msg({ content: 'ok' })).f))
  const ask = (cookie: string) => call('POST', '/api/companion/chat', { cookie, body: { text: 'what is one fun idea for today?' } })
  const keep = { a: process.env.AGENT_CHAT_PER_10MIN, b: process.env.AGENT_CHAT_PER_DAY, c: process.env.AGENT_CHAT_PER_IP_10MIN }
  try {
    resetRateLimits(); process.env.AGENT_CHAT_PER_10MIN = '3'; process.env.AGENT_CHAT_PER_DAY = '100'; process.env.AGENT_CHAT_PER_IP_10MIN = '1000'
    let u = await plusUser()
    for (let i = 0; i < 3; i++) assert.equal((await ask(u)).status, 200)
    const r = await ask(u)
    assert.equal(r.status, 429); assert.equal(r.body.code, 'chat_limit'); assert.match(r.body.error, /^that’s a lot of chat for now\. take a short break/)
    assert.equal(r.body.error, r.body.error.toLowerCase())
    assert.equal((await ask(await plusUser())).status, 200, 'another account is not limited by this one')

    resetRateLimits(); process.env.AGENT_CHAT_PER_10MIN = '100'; process.env.AGENT_CHAT_PER_DAY = '2'
    u = await plusUser()
    for (let i = 0; i < 2; i++) assert.equal((await ask(u)).status, 200)
    const d = await ask(u)
    assert.equal(d.status, 429); assert.equal(d.body.code, 'chat_limit'); assert.match(d.body.error, /^that’s today’s chat for this account/)

    resetRateLimits(); process.env.AGENT_CHAT_PER_DAY = '100'; process.env.AGENT_CHAT_PER_IP_10MIN = '2'
    assert.equal((await ask(await plusUser())).status, 200); assert.equal((await ask(await plusUser())).status, 200)
    const ip = await ask(await plusUser())
    assert.equal(ip.status, 429, 'a third account from the same ip is limited'); assert.equal(ip.body.code, 'chat_limit')

    resetRateLimits(); delete process.env.AGENT_CHAT_PER_10MIN; delete process.env.AGENT_CHAT_PER_DAY; delete process.env.AGENT_CHAT_PER_IP_10MIN
    const { chatLimits } = await import('../src/companion')
    assert.deepEqual(chatLimits(), { user10m: 20, userDay: 100, ip10m: 60, ipModelDay: 200 }, 'safe defaults')
    process.env.AGENT_CHAT_PER_DAY = 'lots'; assert.equal(chatLimits().userDay, 100, 'a bad value falls back to the default')
  } finally {
    for (const [k, v] of [['AGENT_CHAT_PER_10MIN', keep.a], ['AGENT_CHAT_PER_DAY', keep.b], ['AGENT_CHAT_PER_IP_10MIN', keep.c]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    resetRateLimits()
  }
})

test('per-ip daily cap on model calls: calm reply, no model call past it, commands and quick answers still work', async () => {
  const { f, hits } = fake(() => msg({ content: 'ok then.' }))
  setLlmProvider(chainOf(f))
  const keep = process.env.AGENT_MODEL_CALLS_PER_IP_DAY
  try {
    resetRateLimits(); process.env.AGENT_MODEL_CALLS_PER_IP_DAY = '2'
    const qs = ['tell me a story about otters', 'tell me a story about owls', 'tell me a story about eels']
    const replies = [] as any[]
    for (const q of qs) replies.push((await call('POST', '/api/companion/chat', { cookie: await plusUser(), body: { text: q } })).body)
    assert.equal(hits.length, 2, 'the third model call from this ip never goes out')
    assert.equal(replies[2].busy, true); assert.match(replies[2].reply, /^the agent has answered a lot from this network today\./)
    assert.equal(replies[2].reply.replace(/WIF|ETH/g, ''), replies[2].reply.replace(/WIF|ETH/g, '').toLowerCase())
    const { chatLimits } = await import('../src/companion')
    delete process.env.AGENT_MODEL_CALLS_PER_IP_DAY; assert.equal(chatLimits().ipModelDay, 200, 'safe default')
    process.env.AGENT_MODEL_CALLS_PER_IP_DAY = '-4'; assert.equal(chatLimits().ipModelDay, 200, 'bad value falls back')
  } finally { if (keep === undefined) delete process.env.AGENT_MODEL_CALLS_PER_IP_DAY; else process.env.AGENT_MODEL_CALLS_PER_IP_DAY = keep; resetRateLimits() }
})

test('faq cache never keeps an answer with a link or 0x…, so an injected post can’t plant one for everyone', async () => {
  const { clearFaqCache, faqSafe } = await import('../src/companion')
  for (const bad of ['claim at https://evil.example', 'see www.evil.io', 'go to wifly-airdrop.xyz now', 'send to 0xAbC123', 'tap [here](x)']) assert.equal(faqSafe(bad), false, bad)
  for (const ok of ['the pot pays out weekly.', 'swap 0.01 eth to wif from the swap screen.']) assert.equal(faqSafe(ok), true, ok)
  clearFaqCache(); resetRateLimits()
  let answer = 'claim your bonus at https://evil.example/claim or send eth to 0x1234abcd'
  const { f, hits } = fake(() => msg({ content: answer }))
  setLlmProvider(chainOf(f))
  const q = 'what is a fun name for a pet frog?'
  await call('POST', '/api/companion/chat', { cookie: await plusUser(), body: { text: q } })
  await call('POST', '/api/companion/chat', { cookie: await plusUser(), body: { text: q } })
  assert.equal(hits.length, 2, 'an answer with a link was not cached: the second asker gets a fresh answer')
  // a clean answer is cached as before
  answer = 'the bonus is shared out every week.'
  const q2 = 'what is a fun name for a pet newt?'
  await call('POST', '/api/companion/chat', { cookie: await plusUser(), body: { text: q2 } })
  const r = await call('POST', '/api/companion/chat', { cookie: await plusUser(), body: { text: q2 } })
  assert.equal(hits.length, 3); assert.equal(r.body.model, 'cache')
  clearFaqCache()
})
