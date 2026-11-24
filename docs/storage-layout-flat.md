# Storage layout (Flat upgrade)

Compared **main** vs **flat-upgrade** implementations for every upgraded proxy contract. New fields are appended before a reduced `__gap`; slot indices for all pre-upgrade variables are unchanged.

| Contract | New fields (appended) | Gap consumed |
|----------|----------------------|--------------|
| `Wifly` | `feeTreasuryBps`, `feeBurnBps`, `feeSplitSet` | 1 of 48 |
| `WiflyNames` | `claimFee3`, `claimFee2`, `paymentRouter` | 3 of 50 |
| `WiflyDCA` | `runFeeBps`, `runFeeBurnBps`, `runFeeRecipient` | 1 of 50 |
| `WiflyBadges` | (none on this branch) | unchanged |

`forge inspect <Contract> storageLayout` on flat-upgrade confirms no relabeling of existing slots. `WiflyPayments` is a new UUPS contract with its own layout (not an upgrade of an existing proxy).

Test coverage: `WiflyUpgrade.t.sol` (state preserved), `WiflyFlat.t.sol` (`initializeFlat`, tier fees), `WiflyPayments.t.sol`.