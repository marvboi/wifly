/**
 * The agent's signing key lives ONLY in the backend. It is read from the AGENT_PRIVATE_KEY env var (set in
 * Railway; it is never committed, logged, returned by the API or bundled into the web app).
 *
 * Everything else talks to the AgentSigner interface, so a KMS / key-vault signer can replace the env signer later
 * without touching the agent logic: implement AgentSigner and return it from loadAgentSigner() for AGENT_SIGNER=kms.
 */
import { createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { robinhoodChain } from '../chain'
import { rpcUrl } from '../config'

export interface AgentSigner {
  /** Public address of the agent (what users authorise with setAgent). Safe to share. */
  readonly address: Address
  readonly kind: 'env' | 'kms'
  /** Sign and broadcast one contract call; resolves with the tx hash. */
  send(to: Address, data: Hex): Promise<Hex>
}

let cached: AgentSigner | null | undefined
/** Tests can inject a fake signer. */
export function setAgentSigner(s: AgentSigner | null | undefined) { cached = s }

export function loadAgentSigner(): AgentSigner | null {
  if (cached !== undefined) return cached
  const kind = (process.env.AGENT_SIGNER || 'env').toLowerCase()
  if (kind === 'kms') {
    // Placeholder for a KMS / vault-backed signer (AWS KMS, GCP KMS, HashiCorp Vault…). Not wired yet.
    cached = null
    return cached
  }
  cached = envSigner('AGENT_PRIVATE_KEY', 'agent')
  return cached
}

/** Signer from a private key held in an env var (never logged or returned). Null when unset or malformed. */
export function envSigner(envName: string, tag: string): AgentSigner | null {
  const raw = process.env[envName]
  if (!raw) return null
  const pk = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) { console.error(`[${tag}] ${envName} is not a 32-byte hex key; sending disabled`); return null }
  const account = privateKeyToAccount(pk)
  const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(rpcUrl()) })
  return { address: account.address, kind: 'env', send: (to, data) => wallet.sendTransaction({ account, chain: robinhoodChain, to, data }) }
}

let keeperCached: AgentSigner | null | undefined
export function setKeeperSigner(s: AgentSigner | null | undefined) { keeperCached = s }
/**
 * Signer for the weekly keeper (finalizeEpoch is permissionless, so this key only pays gas).
 * KEEPER_SIGNER=env (default) reads KEEPER_PRIVATE_KEY; when that is empty it reuses the agent signer.
 * KEEPER_SIGNER=kms is the same placeholder as the agent's: plug a KMS / vault AgentSigner in here.
 */
export function loadKeeperSigner(): AgentSigner | null {
  if (keeperCached !== undefined) return keeperCached
  if ((process.env.KEEPER_SIGNER || 'env').toLowerCase() === 'kms') { keeperCached = null; return keeperCached }
  keeperCached = envSigner('KEEPER_PRIVATE_KEY', 'keeper') ?? loadAgentSigner()
  return keeperCached
}
