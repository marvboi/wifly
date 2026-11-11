/** speed.12.4 — Experimental Labs fallback after GLM. All fetches mocked; no live calls. */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

for (const k of ['ZAI_API_KEY', 'OPENROUTER_API_KEY', 'EXPLABS_API_KEY', 'EXPLABS_MODEL', 'AI_MODELS']) delete process.env[k]
const {
  ZaiGlm, OpenRouter, Explabs, LlmChain, LlmBusy, llmProvider, DEFAULT_MODELS,
  ZAI_ENDPOINT, EXPLABS_ENDPOINT, EXPLABS_DEFAULT_MODEL, EXPLABS_TIMEOUT_MS,
  cleanLlmContent, llmReasonClass,
} = await import('../src/llm')

afterEach(() => { for (const k of ['ZAI_API_KEY', 'OPENROUTER_API_KEY', 'EXPLABS_API_KEY', 'EXPLABS_MODEL', 'AI_MODELS']) delete process.env[k] })

const ok = (content: string, tool_calls?: unknown[]) =>
  new Response(JSON.stringify({ choices: [{ message: { content, ...(tool_calls ? { tool_calls } : {}) } }] }), { status: 200 })
type Hit = { url: string; model: string; auth: string; body: any }
function fake(answer: (h: Hit, init: RequestInit) => Response | Promise<Response>) {
  const hits: Hit[] = []
  const logs: string[] = []
  const orig = console.info
  console.info = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
  const f = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    const h = { url: String(u), model: body.model, auth: String((init.headers as Record<string, string>).authorization), body }
    hits.push(h); return answer(h, init)
  }) as unknown as typeof fetch
  const restore = () => { console.info = orig }
  return { f, hits, logs, restore }
}

const msgs = [{ role: 'user' as const, content: 'hi there' }]
const tools = [{ type: 'function' as const, function: { name: 'prepare_tip', description: 'tip', parameters: { type: 'object', properties: {} } } }]
const SECRET = 'explabs-test-key-not-real'

const chainOf = (f: typeof fetch, zaiMs = 20_000, explabsMs = EXPLABS_TIMEOUT_MS) =>
  new LlmChain([new ZaiGlm('zk-test', f, zaiMs), new Explabs(SECRET, EXPLABS_DEFAULT_MODEL, f, explabsMs)])

test('cleanLlmContent strips think and reasoning tags', () => {
  assert.equal(cleanLlmContent('<think>plan</think>hello'), 'hello')
  assert.equal(cleanLlmContent('<reasoning>why</reasoning>\nok'), 'ok')
  assert.equal(cleanLlmContent('plain'), 'plain')
})

test('llmReasonClass is a short class, not a body or key', () => {
  assert.equal(llmReasonClass(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'timeout')
  assert.equal(llmReasonClass(new LlmBusy()), 'busy')
  assert.equal(llmReasonClass(new Error('explabs 500')), 'http_5xx')
  assert.equal(llmReasonClass(new Error('zai 401')), 'http_4xx')
  assert.equal(llmReasonClass(new Error('explabs 429')), 'http_429')
  assert.equal(llmReasonClass(new Error('explabs: no answer')), 'empty')
})

test('unset EXPLABS_API_KEY keeps today\'s provider chain', () => {
  assert.equal(llmProvider(), null)
  process.env.OPENROUTER_API_KEY = 'ok'
  assert.equal(llmProvider()?.name, 'openrouter')
  process.env.ZAI_API_KEY = 'zk'
  assert.equal(llmProvider()?.name, 'zai>openrouter')
  delete process.env.OPENROUTER_API_KEY
  assert.equal(llmProvider()?.name, 'zai')
  process.env.EXPLABS_API_KEY = SECRET
  assert.equal(llmProvider()?.name, 'zai>explabs', 'key set with glm adds the fallback')
  process.env.OPENROUTER_API_KEY = 'ok'
  assert.equal(llmProvider()?.name, 'zai>explabs>openrouter')
  delete process.env.ZAI_API_KEY
  assert.equal(llmProvider()?.name, 'openrouter', 'explabs is not primary when glm is unset')
})

test('glm success does not call experimental labs', async () => {
  const { f, hits, logs, restore } = fake(h => h.url === ZAI_ENDPOINT ? ok('from glm') : ok('from explabs'))
  try {
    const r = await chainOf(f).chat(msgs, tools)
    assert.equal(r.content, 'from glm')
    assert.equal(r.model, 'glm-4.7-flash')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].url, ZAI_ENDPOINT)
    assert.ok(!logs.some(l => /explabs/.test(l) && /ok/.test(l)))
    assert.ok(logs.some(l => l.includes('provider=zai') && l.includes('ok')))
    assert.ok(!logs.join('\n').includes(SECRET))
    assert.ok(!logs.join('\n').includes('hi there'))
  } finally { restore() }
})

for (const [why, answer, cls] of [
  ['500', () => new Response('oops', { status: 500 }), 'busy'],
  ['429', () => new Response('{}', { status: 429 }), 'busy'],
  ['401', () => new Response('{}', { status: 401 }), 'http_4xx'],
  ['network error', () => { throw new TypeError('fetch failed') }, 'error'],
] as const) {
  test(`glm ${why} retries once on experimental labs with the same request`, async () => {
    const { f, hits, logs, restore } = fake(h => h.url === ZAI_ENDPOINT ? (answer as () => Response)() : ok('<think>x</think>from explabs'))
    try {
      const r = await chainOf(f).chat(msgs, tools)
      assert.equal(r.content, 'from explabs')
      assert.equal(r.model, 'gpt-6-luna')
      assert.equal(hits.length, 2)
      assert.equal(hits[0].url, ZAI_ENDPOINT)
      assert.equal(hits[1].url, EXPLABS_ENDPOINT)
      assert.equal(hits[1].model, 'gpt-6-luna')
      assert.equal(hits[1].auth, `Bearer ${SECRET}`)
      assert.deepEqual(hits[1].body.messages, msgs)
      assert.equal(hits[1].body.tools[0].function.name, 'prepare_tip')
      assert.equal(hits[1].body.tool_choice, 'auto')
      assert.equal(hits[1].body.stream, false)
      assert.equal(hits[1].body.reasoning_effort, 'low')
      assert.equal(hits[1].body.temperature, 0.3)
      assert.ok(logs.some(l => l.includes('provider=zai') && l.includes(cls)))
      assert.ok(logs.some(l => l.includes('provider=explabs') && l.includes('ok')))
      const joined = logs.join('\n')
      assert.ok(!joined.includes(SECRET), 'key never logged')
      assert.ok(!joined.includes('hi there'), 'prompt never logged')
    } finally { restore() }
  })
}

test('glm timeout retries once on experimental labs', async () => {
  const { f, hits, logs, restore } = fake((h, init) => h.url === ZAI_ENDPOINT
    ? new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    : ok('from explabs'))
  try {
    const r = await chainOf(f, 40).chat(msgs, [])
    assert.equal(r.content, 'from explabs')
    assert.equal(hits.length, 2)
    assert.equal(hits[1].url, EXPLABS_ENDPOINT)
    assert.ok(logs.some(l => l.includes('provider=zai') && l.includes('timeout')))
    assert.ok(!logs.join('\n').includes(SECRET))
  } finally { restore() }
})

test('explabs timeout is 10s and tool calls pass through', async () => {
  assert.equal(EXPLABS_TIMEOUT_MS, 10_000)
  assert.equal(EXPLABS_DEFAULT_MODEL, 'gpt-6-luna')
  const calls = [{ id: 'c1', type: 'function', function: { name: 'prepare_tip', arguments: '{"amount":"1"}' } }]
  const { f, hits, restore } = fake(h => h.url === ZAI_ENDPOINT ? new Response('{}', { status: 500 }) : ok('', calls))
  try {
    const r = await chainOf(f).chat(msgs, tools)
    assert.equal(r.content, '')
    assert.equal(r.toolCalls.length, 1)
    assert.equal(r.toolCalls[0].function.name, 'prepare_tip')
    assert.equal(r.toolCalls[0].function.arguments, '{"amount":"1"}')
    assert.equal(hits[1].url, EXPLABS_ENDPOINT)
  } finally { restore() }
})

test('explabs is tried only once, then openrouter if still failing', async () => {
  const { f, hits, restore } = fake(h => {
    if (h.url === ZAI_ENDPOINT) return new Response('{}', { status: 500 })
    if (h.url === EXPLABS_ENDPOINT) return new Response('{}', { status: 500 })
    return ok('from openrouter')
  })
  try {
    const r = await new LlmChain([
      new ZaiGlm('zk', f),
      new Explabs(SECRET, EXPLABS_DEFAULT_MODEL, f),
      new OpenRouter('ok', DEFAULT_MODELS, f),
    ]).chat(msgs, [])
    assert.equal(r.content, 'from openrouter')
    assert.deepEqual(hits.map(h => h.url === ZAI_ENDPOINT ? 'zai' : h.url === EXPLABS_ENDPOINT ? 'explabs' : 'or'), ['zai', 'explabs', 'or'])
    assert.equal(hits.filter(h => h.url === EXPLABS_ENDPOINT).length, 1)
  } finally { restore() }
})
