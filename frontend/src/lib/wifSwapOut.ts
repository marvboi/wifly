// Exact-OUTPUT buys (ETH -> exactly N WIF), built on wifSwap.ts (same pool key, router and quoter).
// Used by every "not enough WIF" shortcut: quote the shortfall + a small buffer and receive exactly that.
// Quote = V4Quoter.quoteExactOutputSingle (eth_call, includes the pool hook's 1% cut, taken from the ETH side here).
// Swap = Universal Router: V4_SWAP [SWAP_EXACT_OUT_SINGLE, SETTLE_ALL, TAKE_ALL] then SWEEP, which returns
// the unused part of msg.value (maxIn - actual) to the sender in the same transaction.
import { type Address, type PublicClient, encodeAbiParameters, encodePacked, parseAbi } from 'viem'
import { ADDR, POOL_KEY, takeAction, topUpCommand, type SwapOpts } from './wifSwap'

const quoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactOutputSingle(QuoteExactSingleParams params) returns (uint256 amountIn, uint256 gasEstimate)',
])
const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])

/** Buffer added to a shortfall so fee rounding or a small price move still leaves enough: 1.3%. */
export const SHORTFALL_BUFFER_BPS = 130n
export const withBuffer = (need: bigint, bps = SHORTFALL_BUFFER_BPS) => (need * (10_000n + bps) + 9_999n) / 10_000n

/** ETH needed to receive exactly `wifOut` WIF (hook fee included). */
export async function quoteBuyExactOut(client: PublicClient, wifOut: bigint) {
  const { result } = await client.simulateContract({
    address: ADDR.v4Quoter, abi: quoterAbi, functionName: 'quoteExactOutputSingle',
    args: [{ poolKey: POOL_KEY, zeroForOne: true, exactAmount: wifOut, hookData: '0x' }],
  })
  return { amountIn: result[0], gasEstimate: result[1] }
}

/** Max ETH to send for an exact-out buy at a given slippage (default 1%). */
export const maxIn = (amountIn: bigint, slippageBps = 100n) => (amountIn * (10_000n + slippageBps) + 9_999n) / 10_000n

const V4_SWAP = 0x10, SWEEP = 0x04
const A = { SWAP_EXACT_OUT_SINGLE: 0x08, SETTLE_ALL: 0x0c } as const

/** `recipient` gets the unused ETH back (the sender's own address). opts.recipient (11.8.5) gets the WIF; opts.gasTopUp adds a little ETH for it. */
export function buildBuyExactOut(wifOut: bigint, amountInMax: bigint, recipient: Address, deadlineSec = 600, opts: SwapOpts = {}) {
  const take = takeAction(POOL_KEY.currency1, wifOut, opts.recipient)
  const top = topUpCommand(opts.gasTopUp)
  const poolKeyType = { type: 'tuple', name: 'poolKey', components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
  ] } as const
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [A.SWAP_EXACT_OUT_SINGLE, A.SETTLE_ALL, take.action])
  const params = [
    encodeAbiParameters(
      [{ type: 'tuple', components: [poolKeyType, { name: 'zeroForOne', type: 'bool' }, { name: 'amountOut', type: 'uint128' }, { name: 'amountInMaximum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }],
      [{ poolKey: POOL_KEY, zeroForOne: true, amountOut: wifOut, amountInMaximum: amountInMax, hookData: '0x' }],
    ),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [POOL_KEY.currency0, amountInMax]), // SETTLE_ALL: pay at most max
    take.param, // TAKE_ALL: at least wifOut to the sender, or TAKE all of it to opts.recipient
  ]
  const v4 = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params])
  const sweep = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [POOL_KEY.currency0, recipient, 0n])
  return {
    address: ADDR.universalRouter, abi: routerAbi, functionName: 'execute' as const,
    // the top-up TRANSFER runs before SWEEP, so the sweep only returns the unused swap ETH to the sender
    args: [top ? encodePacked(['uint8', 'uint8', 'uint8'], [V4_SWAP, top.cmd, SWEEP]) : encodePacked(['uint8', 'uint8'], [V4_SWAP, SWEEP]), top ? [v4, top.input, sweep] : [v4, sweep], BigInt(Math.floor(Date.now() / 1000) + deadlineSec)] as const,
    value: amountInMax + (top ? opts.gasTopUp!.wei : 0n),
  }
}
