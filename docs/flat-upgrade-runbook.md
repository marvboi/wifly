# Flat upgrade runbook (Marv, Robinhood Chain 4663)

Upgrade **existing** UUPS proxies only. No new proxies. **You** broadcast from the proxy **owner** wallet (treasury by default). Never commit private keys or paste them into files.

## Live proxy addresses (from deploy records)

| Contract | Proxy |
|----------|-------|
| Wifly | `0x1eeB081a4529A2905Ea888948185ADa66c0619F5` |
| WiflyNames | `0x6270008BCd75868044ae7Eb7A3a0840625033477` |
| WiflyBadges | `0x28CA50899aC1b92fB3b2b7212ec8693BeD9F24d6` *(unchanged on this branch)* |
| WiflyDCA | `0x3D1E4966f73e2dFf4f7A520Ce7E4d638cA55C109` *(unchanged on this branch)* |

**Signer:** `owner()` on Wifly and WiflyNames must match. Default live owner / treasury: `0x8E5f84738C0fb29670F370F73E53BD234CEfeF21`.

**Plus creator (Marv):** `initializeV4` uses **`PLUS_CREATOR_ADDRESS` = treasury / owner** (`0x8E5f84738C0fb29670F370F73E53BD234CEfeF21`). The upgrade script and fork rehearsal default to that address when the env var is unset.

**USDG token (constant):** `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`

Scripts: `contracts/script/UpgradeFlat.s.sol` (state-changing), `contracts/script/VerifyFlat.s.sol` (read-only).

---

## Environment (bash)

```bash
cd contracts
export RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com
export WIFLY_CONTRACT_ADDRESS=0x1eeB081a4529A2905Ea888948185ADa66c0619F5
export NAMES_CONTRACT_ADDRESS=0x6270008BCd75868044ae7Eb7A3a0840625033477
# Optional: defaults to treasury (0x8E5f...F21) — same as proxy owner; unset is fine.
# export PLUS_CREATOR_ADDRESS=0x8E5f84738C0fb29670F370F73E53BD234CEfeF21
# Optional: micro-USDG per 1 WIF (see UsdMath). Omit to leave rate at 0 until set later.
# export USDG_PER_WIF=788
```

Load a key via **encrypted keystore**, **Ledger** (`--ledger`), or **`--interactive`** / **`--account <label>`** — not env vars in committed files.

## Environment (PowerShell)

```powershell
cd contracts
$env:RH_RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
$env:WIFLY_CONTRACT_ADDRESS = "0x1eeB081a4529A2905Ea888948185ADa66c0619F5"
$env:NAMES_CONTRACT_ADDRESS = "0x6270008BCd75868044ae7Eb7A3a0840625033477"
# Optional: defaults to treasury 0x8E5f84738C0fb29670F370F73E53BD234CEfeF21
# $env:PLUS_CREATOR_ADDRESS = "0x8E5f84738C0fb29670F370F73E53BD234CEfeF21"
# $env:USDG_PER_WIF = "788"
```

---

## Fork rehearsal (optional, no keys)

Simulates the upgrade on a mainnet fork and asserts storage + sample name claim + Plus subscribe:

```bash
cd contracts
export RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com
# PLUS_CREATOR_ADDRESS unset → treasury 0x8E5f84738C0fb29670F370F73E53BD234CEfeF21
forge test --match-contract UpgradeFlatFork -vv
```

Or script dry-run against a local fork (Anvil):

```bash
# Terminal 1
anvil --fork-url "$RH_RPC_URL" --chain-id 4663

# Terminal 2
export RPC=http://127.0.0.1:8545
forge script script/UpgradeFlat.s.sol:UpgradeFlat \
  --rpc-url "$RPC" \
  --sender 0x8E5f84738C0fb29670F370F73E53BD234CEfeF21 \
  --unlocked
```

---

## Dry-run on live RPC (no broadcast)

```bash
cd contracts
forge script script/UpgradeFlat.s.sol:UpgradeFlat \
  --rpc-url "$RH_RPC_URL" \
  -vvvv
```

No `--broadcast`. Review logged impl addresses and which initializers will run (skips any step already applied on-chain).

---

## Real upgrade (broadcast)

Use **`--slow`** for safer nonce handling on a live chain.

**Keystore account:**

```bash
forge script script/UpgradeFlat.s.sol:UpgradeFlat \
  --rpc-url "$RH_RPC_URL" \
  --account marv-owner \
  --broadcast \
  --slow \
  -vvvv
```

**Ledger:**

```bash
forge script script/UpgradeFlat.s.sol:UpgradeFlat \
  --rpc-url "$RH_RPC_URL" \
  --ledger \
  --broadcast \
  --slow \
  -vvvv
```

**Interactive:**

```bash
forge script script/UpgradeFlat.s.sol:UpgradeFlat \
  --rpc-url "$RH_RPC_URL" \
  --interactive \
  --broadcast \
  --slow \
  -vvvv
```

The broadcaster address must be the proxy `owner()`.

---

## Verify new implementations on Blockscout

After broadcast, note the **new implementation** addresses from the script logs.

```bash
WIFLY_IMPL=<logged Wifly impl>
NAMES_IMPL=<logged WiflyNames impl>

forge verify-contract "$WIFLY_IMPL" src/Wifly.sol:Wifly \
  --chain-id 4663 \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/

forge verify-contract "$NAMES_IMPL" src/WiflyNames.sol:WiflyNames \
  --chain-id 4663 \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/
```

Or add `--verify` to the broadcast `forge script` command (same verifier settings).

---

## Post-upgrade read-only check

```bash
forge script script/VerifyFlat.s.sol:VerifyFlat \
  --rpc-url "$RH_RPC_URL" \
  -vv
```

Expect:

- Fee split: `feeSplitSet`, treasury **2000** bps, burn **1000** bps (70% pot / 10% burn / 20% treasury when flat is on).
- Name tiers: **200 / 2000 / 4000 / 8000** WIF; Plus tier 0: **3000 / 30000** WIF; vote floor **30** WIF.
- `usdg` on Wifly and Names = `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.
- Owner unchanged; implementation slots point at new bytecode.

---

## What the upgrade script does

1. Deploy fresh `Wifly` and `WiflyNames` implementations.
2. For each proxy, `upgradeToAndCall` in order, **skipping** steps already applied:
   - **Wifly:** `initializeFlat` → `initializeV3` → `initializeV4(PLUS_CREATOR_ADDRESS)`.
   - **WiflyNames:** `initializeV2(200e18, 2000e18, 4000e18, 8000e18)` → `initializeV3()`.
3. If `USDG_PER_WIF` is set in the environment, calls `setUsdgPerWif` on both contracts.

Does **not** deploy proxies or upgrade Badges/DCA on this branch.