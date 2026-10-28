/**
 * Companion chat model: OpenRouter (OpenAI-compatible chat/completions with tool calling), server-side only.
 *
 * - OPENROUTER_API_KEY: set in Railway. Never in code, never sent to the browser, never logged. Unset = chat off.
 * - AI_MODELS: comma-separated, tried in order. FREE MODELS ONLY: anything that isn't a ":free" model or
 *   the openrouter/free router is dropped, for Plus users too. Default:
 *   nvidia/nemotron-3-super-120b-a12b:free, google/gemma-4-31b-it:free, openrouter/free
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
  chat(messages: ChatMsg[], tools: ToolDef[], o?: { maxTokens?: number }): Promise<LlmReply>
}

export class LlmBusy extends Error { constructor() { super('busy') } }

/** Free models only (no paid AI for now). */
export const DEFAULT_MODELS = ['nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free', 'openrouter/free']
/** Only free OpenRouter models: "<model>:free" or the openrouter/free router. No paid model anywhere. */
export const isFreeModel = (m: string) => /^[\w.-]+\/[\w.:-]+:free$/.test(m) || m === 'openrouter/free'
export const aiModels = () => {
  const list = (process.env.AI_MODELS || '').split(',').map(s => s.trim()).filter(isFreeModel)
  return list.length ? list : DEFAULT_MODELS
}
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20_000)

export class OpenRouter implements LlmProvider {
  readonly name = 'openrouter'
  private models: string[]
  constructor(private key: string, models: string[], private doFetch: typeof fetch = fetch) {
    this.models = models.filter(isFreeModel) // belt and braces: a paid model never gets a request
    if (!this.models.length) this.models = [...DEFAULT_MODELS]
  }
  async chat(messages: ChatMsg[], tools: ToolDef[], o: { maxTokens?: number } = {}): Promise<LlmReply> {
    let busy = false
    for (const model of this.models) {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
      try {
        const r = await this.doFetch(ENDPOINT, {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}`, 'X-Title': 'Wifly' },
          body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', max_tokens: o.maxTokens ?? 400, temperature: 0.3 }),
        })
        if (r.status === 429 || r.status >= 500 || r.status === 408) { busy = true; continue } // free tier full: next model
        if (!r.ok) continue // model gone / bad request for this model: try the next one
        const j = await r.json() as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[]; error?: { code?: number } }
        if (j.error) { busy = busy || j.error.code === 429; continue }
        const m = j.choices?.[0]?.message
        if (!m) continue
        return { content: String(m.content ?? '').trim(), toolCalls: (m.tool_calls ?? []).filter(c => c?.function?.name), model }
      } catch { busy = true } finally { clearTimeout(t) }
    }
    throw busy ? new LlmBusy() : new Error('no model answered')
  }
}

let override: LlmProvider | null | undefined
/** Tests inject a fake provider (or null to force chat off). */
export function setLlmProvider(p: LlmProvider | null | undefined) { override = p }

export function llmProvider(): LlmProvider | null {
  if (override !== undefined) return override
  const key = process.env.OPENROUTER_API_KEY
  return key ? new OpenRouter(key, aiModels()) : null
}
export const llmDailyLimit = () => Math.max(1, Number(process.env.AI_DAILY_LIMIT || 60))
export const llmPerMinute = () => Math.max(1, Number(process.env.AI_PER_MINUTE || 6))
