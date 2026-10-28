/**
 * Companion chat model, server-side only. Free models only, everywhere.
 *
 * - ZAI_API_KEY: Z.ai GLM (OpenAI-compatible), model glm-4.7-flash (free). Fixed in code, no env picks the model.
 *   When set it answers first; a 429, timeout or any error moves on to OpenRouter.
 * - OPENROUTER_API_KEY: the fallback (or the only model when ZAI_API_KEY is unset). Both keys: set in Railway,
 *   never in code, never sent to the browser, never logged. Neither set = chat off.
 * - AI_MODELS: comma-separated OpenRouter models, tried in order. FREE MODELS ONLY: anything that isn't a
 *   "<vendor>/<model>:free" id is dropped, for Plus users too. Default:
 *   google/gemma-4-31b-it:free, nvidia/nemotron-3.5-super-vl:free
 * - Free-tier limits: a 429 / 5xx / timeout on one model moves to the next; if all are busy we throw LlmBusy and the
 *   companion says "busy, try again" instead of failing.
 * - The model never holds keys or sends transactions. Its tools only PREPARE confirm cards (see ../companion.ts).
 */
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatMsg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }
export type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type LlmReply = { content: string; toolCalls: ToolCall[]; model: string }

export interface LlmProvider {
  readonly name: string
  chat(messages: ChatMsg[], tools: ToolDef[], o?: ChatOpts): Promise<LlmReply>
}
/** deadline: epoch ms for the whole answer (all providers, all models). Past it = busy, no new request. */
export type ChatOpts = { maxTokens?: number; deadline?: number }

export class LlmBusy extends Error { constructor() { super('busy') } }

/** Free models only (no paid AI for now). */
export const DEFAULT_MODELS = ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3.5-super-vl:free']
/** Only free OpenRouter model ids: "<vendor>/<model>:free". No router, no paid model anywhere. */
export const isFreeModel = (m: string) => /^[\w.-]+\/[\w.-]+:free$/.test(m)
export const aiModels = () => {
  const list = (process.env.AI_MODELS || '').split(',').map(s => s.trim()).filter(isFreeModel)
  return list.length ? list : DEFAULT_MODELS
}
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20_000)
/** per-request timeout, never past the whole-answer deadline. 0 = no time left. */
const MIN_REQUEST_MS = 25 // a few leftover ms (timer vs clock skew) isn't time for another request
const budget = (per: number, o: ChatOpts) => {
  if (!o.deadline) return per
  const left = o.deadline - Date.now()
  return left < MIN_REQUEST_MS ? 0 : Math.min(per, left)
}
type RawMsg = { content?: string | null; tool_calls?: unknown[] }
/** Free models return tool calls a bit differently: arguments as an object, no id, no type. Make them one shape. */
export function normCalls(raw: unknown[] | undefined): ToolCall[] {
  return (raw ?? []).flatMap((c: any, i) => {
    const name = c?.function?.name
    if (typeof name !== 'string' || !name) return []
    const a = c.function.arguments
    return [{ id: typeof c.id === 'string' && c.id ? c.id : `call_${i}`, type: 'function' as const, function: { name, arguments: typeof a === 'string' ? a : JSON.stringify(a ?? {}) } }]
  })
}
/** We ask for stream:false. If a provider streams anyway (text/event-stream), stitch the deltas back into one message. */
export async function readMessage(r: Response): Promise<{ msg: RawMsg | null; error: any }> {
  if (!(r.headers.get('content-type') || '').includes('event-stream')) {
    const j = await r.json() as { choices?: { message?: RawMsg }[]; error?: any }
    return { msg: j.choices?.[0]?.message ?? null, error: j.error ?? null }
  }
  let content = '', got = false
  const calls: any[] = []
  for (const line of (await r.text()).split('\n')) {
    const d = line.startsWith('data:') ? line.slice(5).trim() : ''
    if (!d || d === '[DONE]') continue
    const j = JSON.parse(d)
    if (j.error) return { msg: null, error: j.error }
    const delta = j.choices?.[0]?.delta ?? j.choices?.[0]?.message
    if (!delta) continue
    got = true
    if (typeof delta.content === 'string') content += delta.content
    for (const tc of delta.tool_calls ?? []) {
      const at = calls[tc.index ?? calls.length] ??= { id: '', function: { name: '', arguments: '' } }
      if (tc.id) at.id = tc.id
      if (tc.function?.name) at.function.name += tc.function.name
      if (tc.function?.arguments) at.function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)
    }
  }
  return { msg: got ? { content, tool_calls: calls.filter(Boolean) } : null, error: null }
}

export class OpenRouter implements LlmProvider {
  readonly name = 'openrouter'
  private models: string[]
  constructor(private key: string, models: string[], private doFetch: typeof fetch = fetch) {
    this.models = models.filter(isFreeModel) // belt and braces: a paid model never gets a request
    if (!this.models.length) this.models = [...DEFAULT_MODELS]
  }
  async chat(messages: ChatMsg[], tools: ToolDef[], o: ChatOpts = {}): Promise<LlmReply> {
    let busy = false
    for (const model of this.models) {
      const ms = budget(TIMEOUT_MS, o)
      if (ms <= 0) { busy = true; break } // out of time for this answer: say busy, don't start another request
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms)
      try {
        const r = await this.doFetch(ENDPOINT, {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}`, 'X-Title': 'Wifly' },
          // no tools key at all on the last round: some free models reject an empty tools list
          body: JSON.stringify({ model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), stream: false, max_tokens: o.maxTokens ?? 400, temperature: 0.3 }),
        })
        if (r.status === 429 || r.status >= 500 || r.status === 408) { busy = true; continue } // free tier full: next model
        if (!r.ok) continue // model gone / bad request for this model: try the next one
        const { msg: m, error } = await readMessage(r)
        if (error) { busy = busy || Number(error.code) === 429; continue }
        if (!m) continue
        return { content: String(m.content ?? '').trim(), toolCalls: normCalls(m.tool_calls), model }
      } catch { busy = true } finally { clearTimeout(t) }
    }
    throw busy ? new LlmBusy() : new Error('no model answered')
  }
}

/** Z.ai GLM: the free flash model only. One try; anything but a clean answer throws so the chain moves on. */
export const ZAI_ENDPOINT = 'https://api.z.ai/api/paas/v4/chat/completions'
export const ZAI_MODEL = 'glm-4.7-flash'
export class ZaiGlm implements LlmProvider {
  readonly name = 'zai'
  constructor(private key: string, private doFetch: typeof fetch = fetch, private timeoutMs = TIMEOUT_MS) {}
  async chat(messages: ChatMsg[], tools: ToolDef[], o: ChatOpts = {}): Promise<LlmReply> {
    const ms = budget(this.timeoutMs, o)
    if (ms <= 0) throw new LlmBusy()
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms)
    try {
      const r = await this.doFetch(ZAI_ENDPOINT, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: ZAI_MODEL, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), stream: false, max_tokens: o.maxTokens ?? 400, temperature: 0.3 }),
      })
      if (r.status === 429 || r.status === 408 || r.status >= 500) throw new LlmBusy()
      if (!r.ok) throw new Error(`zai ${r.status}`)
      const { msg: m, error } = await readMessage(r)
      if (error || !m) throw new Error('zai: no answer')
      return { content: String(m.content ?? '').trim(), toolCalls: normCalls(m.tool_calls), model: ZAI_MODEL }
    } finally { clearTimeout(t) }
  }
}

/** Try providers in order; a busy / failed one hands over to the next. Busy if any said busy, else the last error. */
export class LlmChain implements LlmProvider {
  readonly name: string
  constructor(private list: LlmProvider[]) { this.name = list.map(p => p.name).join('>') }
  async chat(messages: ChatMsg[], tools: ToolDef[], o?: ChatOpts): Promise<LlmReply> {
    let busy = false, last: unknown = null
    for (const p of this.list) {
      try { return await p.chat(messages, tools, o) } catch (e) { last = e; busy = busy || e instanceof LlmBusy || (e as Error)?.name === 'AbortError' }
    }
    throw busy ? new LlmBusy() : (last ?? new Error('no model answered'))
  }
}

let override: LlmProvider | null | undefined
/** Tests inject a fake provider (or null to force chat off). */
export function setLlmProvider(p: LlmProvider | null | undefined) { override = p }

export function llmProvider(): LlmProvider | null {
  if (override !== undefined) return override
  const zai = process.env.ZAI_API_KEY, or = process.env.OPENROUTER_API_KEY
  const list: LlmProvider[] = []
  if (zai) list.push(new ZaiGlm(zai))
  if (or) list.push(new OpenRouter(or, aiModels()))
  return list.length === 0 ? null : list.length === 1 ? list[0] : new LlmChain(list)
}
/** whole companion answer (every tool round, every fallback) gets this long, then it says busy. */
export const llmAnswerBudgetMs = () => Math.max(5_000, Number(process.env.AI_ANSWER_BUDGET_MS || 45_000))
export const llmDailyLimit = () => Math.max(1, Number(process.env.AI_DAILY_LIMIT || 60))
export const llmPerMinute = () => Math.max(1, Number(process.env.AI_PER_MINUTE || 6))
