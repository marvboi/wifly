# Storage layout — Flat upgrade

Appended slots only (no relabeling of existing proxy storage).

| Contract | v2 append | v3 append | Gap left |
|----------|-----------|-----------|----------|
| `Wifly` | `feeTreasuryBps`, `feeBurnBps`, `feeSplitSet` (3) | `usdg`, `swapRouter`, `usdgPerWif`, `minVoteAmount` (4) | 43 of 48 |
| `WiflyNames` | `claimFee3`, `claimFee2`, `paymentRouter` (3; router deprecated) | `usdg`, `swapRouter`, `usdgPerWif` (3) | 44 of 50 |

Verify: `cd contracts && forge inspect Wifly storageLayout` and `forge inspect WiflyNames storageLayout` on `flat-upgrade`.

Multi-token checkout lives on the existing Wifly / WiflyNames implementations (`initializeV3`); there is no separate payments proxy.

Tests: `WiflyUpgrade.t.sol`, `WiflyFlat.t.sol`, `WiflyCheckout.t.sol`, `UsdMath` via checkout tests.

### Wifly bytecode (EIP-170)

`foundry.toml` compiles **only** `src/Wifly.sol` with `via_ir = true` and `optimizer_runs = 1` (other contracts stay at 200 runs). As of this branch:

| Contract | Runtime size | Limit (24,576 B) |
|----------|-------------:|------------------|
| Wifly | ~23,530 B | OK (~1 KB headroom) |
| WiflyNames | ~23,899 B | OK (~677 B headroom) |

Tradeoff: lower `optimizer_runs` on Wifly favors smaller deployment bytecode over cheapest runtime gas (e.g. `payPlusUsdg` ~324k gas in tests). No linked library used.