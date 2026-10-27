# In-app swap (ETH <-> WIF)

The swap modal trades against the Uniswap v4 ETH/WIF pool on Robinhood Chain, quoting with V4Quoter and executing through
the Universal Router (`V4_SWAP`). Code: `frontend/src/lib/wifSwap.ts` (exact input) and `wifSwapOut.ts` (exact output).

## Pool

- Pool id: `0x71ef4106340f0a3b9c19ec994eef4fc44a1d2513f38faac39d7636b156548c79`
- currency0: native ETH, currency1: WIF `0x5173b8eA6923c2d40267890D45C46a3480954773`
- fee 0, tickSpacing 200, hook `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044`
- The hook takes 1% of the output side. V4Quoter simulates the hook, so quotes already include it.
- Buy is `zeroForOne: true`, sell is `zeroForOne: false`.

## Addresses (4663)

| | |
|---|---|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| V4Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

## Flow

- Default slippage 1%, deadline 10 minutes, re-quote while the modal is open, `simulateContract` before the wallet opens.
- Buys send ETH as `msg.value`, no approval.
- Sells: `WIF.approve(Permit2, amount)` and `Permit2.approve(WIF, router, amount, expiry)` only when the current allowance is
  too low, then `execute`.
- Encoding: command `0x10` (V4_SWAP) with actions `0x06 0x0c 0x0f` (SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL).
