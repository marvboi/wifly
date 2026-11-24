# New user-facing strings (Flat upgrade)

Only **new** copy introduced on this branch. **USDG** is always uppercase in UI.

## Plus (`frontend/src/pages/Plus.tsx`)

- Lede (unchanged): `a monthly or yearly pass, paid in wif.`
- `checkout can also settle in USDG or ETH on Wifly.` (when alt pay is live)
- Pay-token picker: **USDG**, **ETH**, **wif**

## Names claim (`frontend/src/pages/Names.tsx`)

- CTA pattern: `claim {name}.wif for {amount} USDG` (or ETH via placeholder quote)

## Post boost (`frontend/src/sheets/Sheets.tsx`)

- `boost for {amount} USDG` / ETH variants via `formatPayLine`

## Creator earnings (`frontend/src/pages/Earnings.tsx`)

- `plus, names and boosts can also settle in USDG or ETH on Wifly.`

## USDG asset

- Official token logo: `frontend/public/brand/usdg-token.svg`
- Source: Global Dollar (USDG) brand resources — token logo download ZIP at `https://framerusercontent.com/assets/llo5qqG8OQbvOU2QpFJPTdUyn0.zip` (also linked from [globaldollar.com/brand](https://globaldollar.com/brand) and [paxos.com/brand-resources](https://www.paxos.com/brand-resources))
- Token on Robinhood Chain: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, **6 decimals**