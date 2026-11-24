# Flat UI declutter (Marv review)

No copy was reworded or removed from source; lines were hidden, collapsed, or moved to existing **InfoTip** / **details** toggles. Features unchanged.

## Names — search & claim (`ClaimBox`, claim tab)

| Former placement | String / UI | Now |
|------------------|-------------|-----|
| Under price | `≈ ~USDG · ~eth` (duplicate tilde) | Single `≈` via `formatPayLine` (still shows USDG/eth quotes) |
| InfoTip | claim fee tiers | Unchanged; also holds “checkout can also settle in USDG or eth on wifly.” |
| Above claim btn | `LowBalance` row | Only when **details** is open and balance is short |
| Page foot (claim tab) | `how .wif works` grid | Collapsed under **how .wif works** `<details>` (`WifHowCollapsed`) |
| Checkout | `PayingFrom` | Still directly above claim (compact payer row) |

## Plus (`Plus.tsx`)

| Former placement | String / UI | Now |
|------------------|-------------|-----|
| Hero lede | `checkout can also settle in USDG or eth on wifly.` | **InfoTip** on pay token row |
| Below pay button | `plusx-wallet` balance + get wif | **details** toggle only |
| Below pay button | stack / proration note (`plus-stack-note`) | **details** toggle only |
| Below hero | `where your wif goes`, fee split, `how paying works` steps | Collapsed **payment details** `<details>` |
| Checkout | `PayingFrom` | Kept as single payer row above pay button (replaces duplicate wallet line) |

## Boost sheet (`BoostSheet`)

| Former placement | String / UI | Now |
|------------------|-------------|-----|
| Sheet body | Muted intro only | **InfoTip** carries promotion explainer (same string as bid sheet) |
| Body | USDG/eth estimate paragraph | **InfoTip** “USDG or eth quote” |
| Footer | `TxSteps` + embedded `PayingFrom` | One **PayingFrom** in footer; steps only when **fee details** open (`payer={false}`) |
| Body | Fee rows + `FeeParts` | **fee details** toggle |
| Body | `LowBalance` | Inside **fee details** when open |

## Creator earnings (`Earnings.tsx`)

| Former placement | String / UI | Now |
|------------------|-------------|-----|
| Card | `platform fee split (flat)` block | **fee split details** toggle |
| Each source row | `local preview totals` / payout notes | **details** on “by source”; notes in DOM (`sr-only` when collapsed) |
| Foot | payouts withdraw copy | Shown when **details** open |
| Page foot | USDG/eth settlements line | **InfoTip** + `sr-only` preserves full sentence |

## USDG / eth quotes (related fix)

Checkout labels use **USD per WIF** from `/api/price` (USDG ≈ same dollars), not 1:1 WIF count. See `frontend/src/lib/payToken.ts` and `backend/test/payToken.test.ts`.