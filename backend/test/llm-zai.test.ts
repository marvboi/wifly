/** The companion model chain: Z.ai GLM (glm-4.7-flash, free) first, OpenRouter (:free models only) on a 429, timeout or error. */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

for (const k of ['ZAI_API_KEY', 'OPENROUTER_API_KEY', 'AI_MODELS']) delete process.env[k]
const { ZaiGlm, OpenRouter, LlmChain, LlmBusy, llmProvider, aiModels, isFreeModel, DEFAULT_MODELS, ZAI_ENDPOINT, ZAI_MODEL } = await import('../src/llm')

afterEach(() => { for (const k of ['ZAI_API_KEY', 'OPENROUTER_API_KEY', 'AI_MODELS']) delete process.env[k] })
const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
type Hit = { url: string; model: string; auth: string }
function fake(answer: (h: Hit, init: RequestInit) => Response | Promise<Response>) {
  const hits: Hit[] = []
  const f = (async (u: string, init: RequestInit) => {
    const h = { url: String(u), model: JSON.parse(String(init.body)).model, auth: String((init.headers as Record<string, string>).authorization) }
    hits.push(h); return answer(h, init)
  }) as unknown as typeof fetch
  return { f, hits }
}
const msgs = [{ role: 'user' as const, content: 'hi' }]

test('glm answers first when it works; openrouter is never called', async () => {
  const { f, hits } = fake(h => h.url === ZAI_ENDPOINT ? ok('from glm') : ok('from openrouter'))
  const chain = new LlmChain([new ZaiGlm('zk', f), new OpenRouter('ok', DEFAULT_MODELS, f)])
  const r = await chain.chat(msgs, [])
  assert.equal(r.content, 'from glm'); assert.equal(r.model, 'glm-4.7-flash')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].url, 'https://api.z.ai/api/paas/v4/chat/completions'); assert.equal(hits[0].model, 'glm-4.7-flash'); assert.equal(hits[0].auth, 'Bearer zk')
})

for (const [why, answer] of [
  ['429', () => new Response('{"error":{"code":"1302"}}', { status: 429 })],
  ['500', () => new Response('oops', { status: 500 })],
  ['401 (bad key)', () => new Response('{}', { status: 401 })],
  ['an error body', () => new Response(JSON.stringify({ error: { message: 'x' } }), { status: 200 })],
  ['a network error', () => { throw new TypeError('fetch failed') }],
] as const) {
  test(`glm ${why} falls back to the openrouter :free model`, async () => {
    const { f, hits } = fake(h => h.url === ZAI_ENDPOINT ? (answer as () => Response)() : ok('from openrouter'))
    const r = await new LlmChain([new ZaiGlm('zk', f), new OpenRouter('ok', DEFAULT_MODELS, f)]).chat(msgs, [])
    assert.equal(r.content, 'from openrouter'); assert.equal(r.model, DEFAULT_MODELS[0]); assert.ok(r.model.endsWith(':free'))
    assert.deepEqual(hits.map(h => h.url.includes('z.ai') ? 'zai' : 'or'), ['zai', 'or'])
    assert.equal(hits[1].auth, 'Bearer ok', 'each provider gets its own key')
  })
}

test('glm timeout falls back to openrouter', async () => {
  const { f } = fake((h, init) => h.url === ZAI_ENDPOINT
    ? new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    : ok('from openrouter'))
  const r = await new LlmChain([new ZaiGlm('zk', f, 50), new OpenRouter('ok', DEFAULT_MODELS, f)]).chat(msgs, [])
  assert.equal(r.content, 'from openrouter')
})

test('everything busy reports busy (the companion says try again)', async () => {
  const { f } = fake(() => new Response('{}', { status: 429 }))
  await assert.rejects(new LlmChain([new ZaiGlm('zk', f), new OpenRouter('ok', DEFAULT_MODELS, f)]).chat(msgs, []), LlmBusy)
})

test('provider from env: zai first when set, openrouter alone otherwise, off with neither', () => {
  assert.equal(llmProvider(), null)
  process.env.OPENROUTER_API_KEY = 'ok'
  assert.equal(llmProvider()?.name, 'openrouter')
  process.env.ZAI_API_KEY = 'zk'
  assert.equal(llmProvider()?.name, 'zai>openrouter')
  delete process.env.OPENROUTER_API_KEY
  assert.equal(llmProvider()?.name, 'zai')
})

test('free models only: glm is the flash model, no env picks a paid one', () => {
  assert.equal(ZAI_MODEL, 'glm-4.7-flash')
  assert.ok(DEFAULT_MODELS.length > 0 && DEFAULT_MODELS.every(m => m.endsWith(':free')))
  for (const m of ['openrouter/free', 'openrouter/auto', 'z-ai/glm-4.7-flash', 'anthropic/claude-x', 'openai/gpt-x', 'x:free', 'a/b:free:paid']) assert.equal(isFreeModel(m), false, m)
  process.env.AI_MODELS = 'openrouter/auto,openrouter/free,anthropic/claude-x'
  assert.deepEqual(aiModels(), DEFAULT_MODELS, 'nothing free listed: the free defaults')
  process.env.AI_MODELS = 'meta/llama-x:free,openai/gpt-x'
  assert.deepEqual(aiModels(), ['meta/llama-x:free'])
  // a paid id handed straight to the class still never gets a request
  const { f, hits } = fake(() => ok('x'))
  void new OpenRouter('ok', ['openai/gpt-x', 'openrouter/auto'], f).chat(msgs, [])
  return new Promise<void>(r => setTimeout(() => { assert.ok(hits.every(h => h.model.endsWith(':free'))); r() }, 20))
})
