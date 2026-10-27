/**
 * Privy sign-in (X or email, embedded EVM wallet on Robinhood Chain; smart wallets off) and the linkHandle attester.
 * Sign-in needs only the public PRIVY_APP_ID: identity tokens are verified locally against Privy's public JWKS
 * (or PRIVY_VERIFICATION_KEY), so no app secret is required. PRIVY_APP_SECRET is optional and, if set, stays on the server.
 * Identity tokens are verified with @privy-io/node (ES256, iss privy.io, aud = our app id) against Privy's JWKS,
 * or against PRIVY_VERIFICATION_KEY when set. Only claims from a verified token are trusted.
 */
import { PrivyClient, type User as PrivyUser } from '@privy-io/node'
import { getAddress, isAddress, keccak256, toBytes, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { chainClient, robinhoodChain } from './chain'
import { attesterConfig, privyConfig } from './config'
import { fail } from './util'

export type PrivyIdentity = {
  did: string
  xUserId: string | null        // numeric X user id (twitter_oauth.subject): stable, unlike the @username
  xUsername: string | null
  xName: string | null
  email: string | null
  smartWallet: string | null    // lowercase
  embeddedWallet: string | null // lowercase
  wallets: string[]             // every EVM address on the Privy user, lowercase
}

export const privyEnabled = () => !!privyConfig().appId

let client: PrivyClient | null = null
let clientKey = ''
function privy(): PrivyClient {
  const c = privyConfig()
  const key = `${c.appId}|${c.verificationKey ?? ''}|${c.appSecret ? 1 : 0}`
  if (!client || key !== clientKey) {
    client = new PrivyClient({ appId: c.appId, appSecret: c.appSecret /* '' is fine: identity-token checks never call Privy's API */, jwtVerificationKey: c.verificationKey })
    clientKey = key
  }
  return client
}

export function identityFrom(user: PrivyUser): PrivyIdentity {
  let xUserId: string | null = null, xUsername: string | null = null, xName: string | null = null
  let email: string | null = null, smartWallet: string | null = null, embeddedWallet: string | null = null
  const wallets: string[] = []
  for (const a of user.linked_accounts as Array<Record<string, any>>) {
    if (a.type === 'twitter_oauth') { xUserId = String(a.subject); xUsername = a.username ?? null; xName = a.name ?? null }
    else if (a.type === 'email' && a.address) email = String(a.address).toLowerCase()
    else if (a.type === 'smart_wallet' && isAddress(a.address)) { smartWallet = a.address.toLowerCase(); wallets.push(smartWallet!) }
    else if (a.type === 'wallet' && a.chain_type === 'ethereum' && isAddress(a.address)) {
      const w = a.address.toLowerCase(); wallets.push(w)
      if (a.wallet_client_type === 'privy' || a.connector_type === 'embedded') embeddedWallet = embeddedWallet ?? w
    }
  }
  return { did: user.id, xUserId, xUsername, xName, email, smartWallet, embeddedWallet, wallets }
}

/** Verifies a Privy identity token and returns the identity in it. 501 when Privy isn't configured, 401 when invalid. */
export async function verifyPrivyToken(token: unknown): Promise<PrivyIdentity> {
  if (!privyEnabled()) fail(501, 'privy sign-in is not configured on this server')
  if (typeof token !== 'string' || token.length < 20 || token.length > 16_000) fail(400, 'missing identity token')
  let user: PrivyUser
  try { user = await privy().users().get({ id_token: token as string }) }
  catch { fail(401, 'identity token is not valid') }
  return identityFrom(user!)
}

/**
 * Access-token fallback for apps with identity tokens switched off in the Privy dashboard. The access token only
 * proves the Privy user id, so the linked accounts are read from Privy's API (needs PRIVY_APP_SECRET).
 */
export async function verifyPrivyAccess(token: unknown): Promise<PrivyIdentity> {
  if (!privyEnabled()) fail(501, 'privy sign-in is not configured on this server')
  if (typeof token !== 'string' || token.length < 20 || token.length > 16_000) fail(400, 'missing access token')
  if (!privyConfig().appSecret) {
    console.error('[privy] no identity token and no PRIVY_APP_SECRET: turn on "return user data in an identity token" in the privy dashboard')
    fail(503, 'sign-in needs identity tokens turned on in the privy dashboard')
  }
  let did = ''
  try { did = (await privy().utils().auth().verifyAccessToken(token as string)).user_id } catch { fail(401, 'access token is not valid') }
  try { return identityFrom(await privy().users()._get(did)) }
  catch (e) { console.error('[privy] user lookup failed', (e as Error)?.message); fail(502, 'could not reach the sign-in service. try again') }
  throw new Error('unreachable')
}
/** Identity token when the client has one, else the access token. */
export function verifyPrivyAny(b: { identityToken?: unknown; accessToken?: unknown }): Promise<PrivyIdentity> {
  return b.identityToken ? verifyPrivyToken(b.identityToken) : verifyPrivyAccess(b.accessToken)
}

// ------------------------------------------------------------------ linkHandle attester

const wiflyAbi = [
  { type: 'function', name: 'handleNonce', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'attester', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

export const xHandleHash = (xUserId: string): Hex => keccak256(toBytes(`x:${xUserId}`))
export const attesterEnabled = () => { const a = attesterConfig(); return !!(a.privateKey && a.contract && isAddress(a.contract)) }

/**
 * Signs Wifly's EIP-712 LinkHandle(handleHash, account, nonce, deadline) for the X account in a *verified* Privy
 * token, bound to one of that Privy user's own wallets. The user's wallet then calls linkHandle itself; the server
 * only signs and reads (handleNonce, attester), it never sends a transaction.
 */
export async function attestLinkHandle(id: PrivyIdentity, requested?: string) {
  if (!attesterEnabled()) fail(503, 'the X attester is not configured yet')
  if (!id.xUserId || !/^\d{1,25}$/.test(id.xUserId)) fail(400, 'sign in with X first')
  const account = (requested ?? id.embeddedWallet ?? id.smartWallet ?? '').toLowerCase()
  if (!isAddress(account) || !id.wallets.includes(account)) fail(403, 'that wallet is not linked to your sign-in')
  const { privateKey, contract } = attesterConfig()
  const signer = privateKeyToAccount(privateKey as Hex)
  const verifyingContract = getAddress(contract as string)
  const c = chainClient()
  const handleHash = xHandleHash(id.xUserId!)
  const [onchainAttester, nonce] = await Promise.all([
    c.readContract({ address: verifyingContract, abi: wiflyAbi, functionName: 'attester' }),
    c.readContract({ address: verifyingContract, abi: wiflyAbi, functionName: 'handleNonce', args: [handleHash] }),
  ]).catch(() => fail(502, 'could not read the Wifly contract'))
  if (getAddress(onchainAttester) !== signer.address) fail(503, 'the attester key does not match the contract’s attester')
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60)
  const message = { handleHash, account: getAddress(account), nonce, deadline }
  const signature = await signer.signTypedData({
    domain: { name: 'Wifly', version: '1', chainId: robinhoodChain.id, verifyingContract },
    types: { LinkHandle: [
      { name: 'handleHash', type: 'bytes32' }, { name: 'account', type: 'address' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ] },
    primaryType: 'LinkHandle',
    message,
  })
  return { xUserId: id.xUserId, handleHash, account: message.account, nonce: nonce.toString(), deadline: deadline.toString(), signature }
}
