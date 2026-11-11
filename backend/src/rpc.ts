/**
 * Robinhood Chain (4663) JSON-RPC reads: a fallback list of free public endpoints, retries with backoff,
 * JSON-RPC batching, and dedupe of identical in-flight requests. RPC_URL (existing) is tried first;
 * RPC_URLS is an optional comma-separated override/addition. No paid or keyed endpoints in the defaults.
 */
import { fallback, http, type Transport } from 'viem'

/** Official public RPC, plus two other keyless public endpoints (dRPC, PublicNode). */
export const OFFICIAL_RPC = 'https://rpc.mainnet.chain.robinhood.com'
export const DEFAULT_RPC_URLS = [
  OFFICIAL_RPC,
  'https://robinhood.drpc.org',
  'https://robinhood-rpc.publicnode.com',
] as const

const HTTP_TIMEOUT_MS = 8_000

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

/** Env first (RPC_URL, then RPC_URLS), then the public defaults. Always at least the official URL. */
export function rpcUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = parseRpcList(env.RPC_URL, env.RPC_URLS, DEFAULT_RPC_URLS.join(','))
  return list.length ? list : [...DEFAULT_RPC_URLS]
}

const READ = /^(eth_|net_|web3_|debug_)/

/** In-flight identical read requests share one round trip. Writes and wallet methods pass through. */
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

/** fallback() over the URL list, each http() batched with retries and backoff, then deduped. */
export function fallbackRpc(urls: string[] = rpcUrls(), httpImpl: typeof http = http): Transport {
  const list = urls.length ? urls : [...DEFAULT_RPC_URLS]
  return dedupeTransport(fallback(
    list.map(url => httpImpl(url, { batch: true, timeout: HTTP_TIMEOUT_MS, retryCount: 2, retryDelay: RETRY_DELAY_MS })),
    { retryCount: 1, retryDelay: RETRY_DELAY_MS },
  ))
}

export const RPC_HTTP_TIMEOUT_MS = HTTP_TIMEOUT_MS
