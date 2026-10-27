import { createPublicClient, defineChain, http, type PublicClient, type Transport } from 'viem'
import { rpcUrl } from './config'

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
})

let client: PublicClient | null = null
let override: Transport | null = null

/** Read-only client for Robinhood Chain. Only eth_call / eth_getCode style reads go through it. */
export function chainClient(): PublicClient {
  // JSON-RPC batching: parallel reads in the same tick share one round trip
  if (!client) client = createPublicClient({ chain: robinhoodChain, transport: override ?? http(rpcUrl(), { batch: true }) }) as PublicClient
  return client
}
/** Tests swap in a fake transport so nothing touches the network. */
export function setChainTransport(t: Transport | null) { override = t; client = null }
