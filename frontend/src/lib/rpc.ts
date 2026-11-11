/**
 * Browser reads on Robinhood Chain (4663): fallback across free public RPCs, retries with backoff,
 * JSON-RPC batching, and dedupe of identical in-flight reads. VITE_RPC_URL / VITE_RPC_URLS override
 * the list (existing RPC_URL is a server env; these are the public build-time equivalents).
 */
import { fallback, http, type Transport } from 'viem'

export const OFFICIAL_RPC = 'https://rpc.mainnet.chain.robinhood.com'
export const DEFAULT_RPC_URLS = [
  OFFICIAL_RPC,
  'https://robinhood.drpc.org',
  'https://robinhood-rpc.publicnode.com',
] as const

const HTTP_TIMEOUT_MS = 8_000
const envOf = () => {
  try { return (import.meta as { env?: Record<string, string | undefined> }).env ?? {} } catch { return {} }
}

export function parseRpcList(...parts: (string | undefined | null)[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    for (const raw of String(part ?? '').split(/[\s,]+/)) {
      const u = raw.trim().replace(/\/$/, '')
      if (!/^https?:\/\//i.test(u) || seen.has(u.toLowerCase())) continue
      seen.add(u.toLowerCase())
      out.push(u)
    }
  }
  return out
}

export function rpcUrls(env: Record<string, string | undefined> = envOf()): string[] {
  const list = parseRpcList(env.VITE_RPC_URL, env.VITE_RPC_URLS, DEFAULT_RPC_URLS.join(','))
  return list.length ? list : [...DEFAULT_RPC_URLS]
}

const READ = /^(eth_|net_|web3_|debug_)/

export function dedupeTransport(t: Transport): Transport {
  return (opts) => {
    const inner = t(opts)
    const inflight = new Map<string, ReturnType<typeof inner.request>>()
    const request = ((args: Parameters<typeof inner.request>[0], options: Parameters<typeof inner.request>[1]) => {
      const method = String((args as { method?: string }).method ?? '')
      if (!READ.test(method)) return inner.request(args, options)
      const key = JSON.stringify([method, (args as { params?: unknown }).params ?? null])
      const hit = inflight.get(key)
      if (hit) return hit
      const p = inner.request(args, options)
      inflight.set(key, p)
      void Promise.resolve(p).finally(() => inflight.delete(key))
      return p
    }) as typeof inner.request
    return { ...inner, request }
  }
}

/** viem multiplies this base by (1 << count) internally, so 100 → 100, 200, 400… */
const RETRY_DELAY_MS = 100

export function fallbackRpc(urls: string[] = rpcUrls(), httpImpl: typeof http = http): Transport {
  const list = urls.length ? urls : [...DEFAULT_RPC_URLS]
  return dedupeTransport(fallback(
    list.map(url => httpImpl(url, { batch: true, timeout: HTTP_TIMEOUT_MS, retryCount: 2, retryDelay: RETRY_DELAY_MS })),
    { retryCount: 1, retryDelay: RETRY_DELAY_MS },
  ))
}

export const RPC_HTTP_TIMEOUT_MS = HTTP_TIMEOUT_MS
