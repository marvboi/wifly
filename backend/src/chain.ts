import { createPublicClient, defineChain, type PublicClient, type Transport } from 'viem'
import { fallbackRpc, rpcUrls, RPC_HTTP_TIMEOUT_MS } from './rpc'
// Each HTTP transport in fallbackRpc uses timeout: 8_000, retries, and JSON-RPC batching.
void RPC_HTTP_TIMEOUT_MS

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [...rpcUrls()] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})

let client: PublicClient | null = null
let override: Transport | null = null

/** Read-only client for Robinhood Chain. Only eth_call / eth_getCode style reads go through it. */
export function chainClient(): PublicClient {
  // fallback across public RPCs; JSON-RPC batching + multicall; identical in-flight reads are deduped.
  // a test-injected transport must see raw eth_call (the fixtures match on params[0].to). Multicall3
  // wrapping would send aggregate3 to 0xcA11… and miss those mocks, so it is only on for the real fallback.
  if (!client) client = createPublicClient({
    chain: robinhoodChain,
    transport: override ?? fallbackRpc(),
    batch: override ? undefined : { multicall: true },
  }) as PublicClient
  return client
}
/** Tests swap in a fake transport so nothing touches the network. */
export function setChainTransport(t: Transport | null) { override = t; client = null }
