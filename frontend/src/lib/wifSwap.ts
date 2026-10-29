// Swap engine, same as swap/src/wifSwap.ts (fork-tested). Keep the two in sync.
// Wifly in-app swap: ETH <-> WIF on Robinhood Chain (4663) through the Uniswap v4 Pons pool.
// Quote = V4Quoter eth_call (includes the pool hook's 1% cut). Swap = Universal Router V4_SWAP.
import {
  type Address, type Hex, type PublicClient, type WalletClient,
  encodeAbiParameters, encodePacked, parseAbi, maxUint160,
} from 'viem'

export const ADDR = {
  WIF: '0x5173b8eA6923c2d40267890D45C46a3480954773',
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904', // UR 2.1.1 (2.1.2: 0x204FAca1764B154221e35c0d20aBb3c525710498)
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
} as const satisfies Record<string, Address>

export const POOL_ID = '0x71ef4106340f0a3b9c19ec994eef4fc44a1d2513f38faac39d7636b156548c79' as const
export const POOL_KEY = {
  currency0: '0x0000000000000000000000000000000000000000', // native ETH
  currency1: ADDR.WIF,
  fee: 0,
  tickSpacing: 200,
  hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044', // PonsV2MemeHook, 1% afterSwap cut
} as const

const poolKeyType = { type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] } as const

const quoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
  'function quoteExactOutputSingle(QuoteExactSingleParams params) returns (uint256 amountIn, uint256 gasEstimate)',
])
const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])
const erc20Abi = parseAbi([
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])
const permit2Abi = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])

export type Side = 'buy' | 'sell' // buy = ETH -> WIF (zeroForOne), sell = WIF -> ETH

/** Exact-input quote. Simulated with eth_call, so it already includes the hook fee. */
export async function quote(client: PublicClient, side: Side, amountIn: bigint) {
  const { result } = await client.simulateContract({
    address: ADDR.v4Quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: POOL_KEY, zeroForOne: side === 'buy', exactAmount: amountIn, hookData: '0x' }],
  })
  return { amountOut: result[0], gasEstimate: result[1] }
}

export const minOut = (amountOut: bigint, slippageBps = 100n) => (amountOut * (10_000n - slippageBps)) / 10_000n

const V4_SWAP = 0x10
/** Universal Router TRANSFER(token, recipient, value): token 0x0 = ETH the router holds (from msg.value). */
export const UR_TRANSFER = 0x05
const A = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f } as const
/**
 * 11.8.5 options. recipient: who gets the output (v4 TAKE(currency, recipient, 0 = the whole open delta); the swap's own
 * amountOutMinimum / exact amountOut still guards the price). gasTopUp: buys only, a little extra ETH in msg.value that the
 * router passes to `to` with TRANSFER in the same transaction (~0.0001 ETH so an embedded wallet can pay its own gas).
 */
export type SwapOpts = { recipient?: Address; gasTopUp?: { to: Address; wei: bigint } }
/** Largest gas top-up we'll ever add, and the default. */
export const MAX_GAS_TOPUP = 1_000_000_000_000_000n // 0.001 ETH
export const GAS_TOPUP_WEI = 100_000_000_000_000n // 0.0001 ETH
export function takeAction(cOut: Address, amountMin: bigint, recipient?: Address): { action: number; param: Hex } {
  return recipient
    ? { action: A.TAKE, param: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [cOut, recipient, 0n]) }
    : { action: A.TAKE_ALL, param: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cOut, amountMin]) }
}
export function topUpCommand(t?: { to: Address; wei: bigint }): { cmd: number; input: Hex } | null {
  if (!t || t.wei <= 0n) return null
  if (t.wei > MAX_GAS_TOPUP) throw new Error('gas top-up too large')
  return { cmd: UR_TRANSFER, input: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], ['0x0000000000000000000000000000000000000000', t.to, t.wei]) }
}

/** Builds the Universal Router call for an exact-input single-pool swap. */
export function buildSwap(side: Side, amountIn: bigint, amountOutMin: bigint, deadlineSec = 600, opts: SwapOpts = {}) {
  const zeroForOne = side === 'buy'
  const [cIn, cOut] = zeroForOne ? [POOL_KEY.currency0, POOL_KEY.currency1] : [POOL_KEY.currency1, POOL_KEY.currency0]
  const take = takeAction(cOut, amountOutMin, opts.recipient)
  const top = zeroForOne ? topUpCommand(opts.gasTopUp) : null
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [A.SWAP_EXACT_IN_SINGLE, A.SETTLE_ALL, take.action])
  const params: Hex[] = [
    encodeAbiParameters(
      [{ type: 'tuple', components: [
        { ...poolKeyType, name: 'poolKey' }, { name: 'zeroForOne', type: 'bool' },
        { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
      ] }],
      [{ poolKey: POOL_KEY, zeroForOne, amountIn, amountOutMinimum: amountOutMin, hookData: '0x' }],
    ),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cIn, amountIn]),     // SETTLE_ALL: pay at most amountIn
    take.param, // TAKE_ALL to the sender (at least min), or TAKE everything owed to opts.recipient
  ]
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params])
  const cmds = top ? encodePacked(['uint8', 'uint8'], [V4_SWAP, top.cmd]) : encodePacked(['uint8'], [V4_SWAP])
  const inputs = top ? [input, top.input] : [input]
  return {
    address: ADDR.universalRouter, abi: routerAbi, functionName: 'execute' as const,
    args: [cmds, inputs, BigInt(Math.floor(Date.now() / 1000) + deadlineSec)] as const,
    value: zeroForOne ? amountIn + (top ? opts.gasTopUp!.wei : 0n) : 0n, // ETH in (plus any gas top-up) is msg.value
  }
}

/** For sells only: WIF -> Permit2 (ERC-20 approve, once), then Permit2 -> Universal Router (amount + expiry). */
export async function ensureSellApprovals(pub: PublicClient, wallet: WalletClient, owner: Address, amount: bigint) {
  const hashes: Hex[] = []
  const erc = await pub.readContract({ address: ADDR.WIF, abi: erc20Abi, functionName: 'allowance', args: [owner, ADDR.permit2] })
  if (erc < amount) {
    // Exact amount is safest. The UI can offer "approve more" as an opt-in.
    hashes.push(await wallet.writeContract({ account: owner, chain: wallet.chain, address: ADDR.WIF, abi: erc20Abi, functionName: 'approve', args: [ADDR.permit2, amount] }))
    await pub.waitForTransactionReceipt({ hash: hashes.at(-1)! })
  }
  const [p2amt, p2exp] = await pub.readContract({ address: ADDR.permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, ADDR.WIF, ADDR.universalRouter] })
  const now = Math.floor(Date.now() / 1000)
  if (p2amt < amount || p2exp <= now) {
    if (amount > maxUint160) throw new Error('amount too large')
    hashes.push(await wallet.writeContract({ account: owner, chain: wallet.chain, address: ADDR.permit2, abi: permit2Abi, functionName: 'approve', args: [ADDR.WIF, ADDR.universalRouter, amount, now + 30 * 60] }))
    await pub.waitForTransactionReceipt({ hash: hashes.at(-1)! })
  }
  return hashes
}

/** Full flow: quote -> (approvals for sells) -> simulate -> send. Always simulate first so a bad quote fails before the wallet pops. */
export async function swap(pub: PublicClient, wallet: WalletClient, owner: Address, side: Side, amountIn: bigint, slippageBps = 100n) {
  const { amountOut } = await quote(pub, side, amountIn)
  const min = minOut(amountOut, slippageBps)
  if (side === 'sell') await ensureSellApprovals(pub, wallet, owner, amountIn)
  const call = buildSwap(side, amountIn, min)
  const { request } = await pub.simulateContract({ account: owner, ...call })
  const hash = await wallet.writeContract({ ...request, chain: wallet.chain })
  return { hash, quotedOut: amountOut, minOut: min }
}
