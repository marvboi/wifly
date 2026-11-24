# Storage layout — Flat upgrade

Appended slots only (no relabeling of existing proxy storage).

| Contract | v2 append | v3 append | Gap left |
|----------|-----------|-----------|----------|
| `Wifly` | `feeTreasuryBps`, `feeBurnBps`, `feeSplitSet` (3) | `usdg`, `swapRouter`, `usdgPerWif`, `minVoteAmount` (4) | 43 of 48 |
| `WiflyNames` | `claimFee3`, `claimFee2`, `paymentRouter` (3; router deprecated) | `usdg`, `swapRouter`, `usdgPerWif` (3) | 44 of 50 |

Verify: `cd contracts && forge inspect Wifly storageLayout` and `forge inspect WiflyNames storageLayout` on `flat-upgrade`.

Multi-token checkout lives on the existing Wifly / WiflyNames implementations (`initializeV3`); there is no separate payments proxy.

Tests: `WiflyUpgrade.t.sol`, `WiflyFlat.t.sol`, `WiflyCheckout.t.sol`, `UsdMath` via checkout tests.