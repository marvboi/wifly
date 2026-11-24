# Flat price table (old vs new)

Values are in WIF unless noted. **Marv-approved** rows are marked.

## .wif name claims (onchain)

| Length | Old | New (Marv approved) |
|--------|-----|---------------------|
| 5+ chars | 100 | 200 |
| 4 chars | 1,000 | 2,000 |
| 3 chars | 1,000 (short tier) | 4,000 |
| 2 chars | closed | 8,000 |

## Wifly Plus

| Plan | Old | New (pending Marv final OK on yearly) |
|------|-----|-----|
| Monthly | 1,500 / 30 days | **3,000 / 30 days** |
| Yearly | 15,000 / 365 days | **30,000 / 365 days** (keeps “2 months free” vs 12× monthly) |

### Plus fee (Marv approved)

| Item | Other platform fees (2%) | Wifly Plus (WIF, USDG, eth) |
|------|--------------------------|-------------------------------|
| Split | 70% pot / 10% burn / 20% treasury (`FLAT_FEE_SPLIT`) | **100% burned** (no pot, no treasury) |
| Example @ 3,000 WIF / month | — | burn **60 wif**, team gets **2,940 wif** |

USDG/eth Plus: swap to WIF first, then the same 2% is burned onchain (or held for burn when the swap router is unset).

## Top Spot / post boost

| Item | Old | New |
|------|-----|-----|
| Minimum bid (floor) | 100 WIF | 100 WIF |
| Raise step | 10% over current | 10% over current |

## Votes

| Item | Old | New (Marv approved) |
|------|-----|---------------------|
| Per vote | 10 WIF | **30 WIF** (`minVoteAmount` via `initializeV3`) |

## Marketplace / fees

| Item | Old | New |
|------|-----|-----|
| .wif resale fee | 2.5% | 2.5% |
| Platform fee (tips, boosts, unlocks, etc.) | 2% | 2% (`FLAT_FEE_SPLIT`) |
| Platform fee (**Wifly Plus** only) | 2% (same split as above) | 2% **100% burned** |

## Payment methods (new)

| Product | WIF | USDG | ETH |
|---------|-----|------|-----|
| Plus | yes | yes (`payPlusUsdg` on Wifly) | yes (`payPlusEth`) |
| Name claim | yes | yes (`payClaimUsdg` on WiflyNames) | yes (`payClaimEth`) |
| Post boost | yes | yes (`payBoostUsdg`) | yes (`payBoostEth`) |

### USDG (Robinhood Chain, chain id 4663)

- **Token:** `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`
- **Decimals:** 6 (not 18)
- **Sources:** [Robinhood Chain contracts](https://docs.robinhood.com/chain/contracts), [Paxos USDG mainnet](https://docs.paxos.com/guides/stablecoin/usdg/mainnet)
- Default set in `initializeV3` on Wifly and WiflyNames; owner may override with `setUsdg`.

On-chain USDG amount for a WIF price: `quoteUsdgForWif(wifWei)` uses `usdgPerWif` (default `1e6` micro-USDG per `1e18` WIF wei). Swaps use `swapRouter` when set.

## Placeholder checkout quotes (display only, not onchain)

Checkout labels prefix alt-token amounts with **~** (config quotes only; not onchain swap rates). See `formatPayQuote` in `frontend/src/lib/payToken.ts`.

Configured in frontend env until live swap quotes drive the UI. Defaults:

| Config key | Default | Meaning |
|------------|---------|---------|
| `VITE_PLACEHOLDER_USDG_PER_WIF` | `1` | 1 WIF shown as 1 USDG on labels (6 decimal display) |
| `VITE_PLACEHOLDER_WIF_PER_ETH` | `1000000` | ETH checkout label: WIF amount / this = ETH shown |

These values are for UI labels only; onchain checkout uses the swap router or `quoteUsdgForWif`.