# New user-facing strings (Flat upgrade)

Only **new** copy introduced on this branch. **USDG** is always uppercase in UI.

## Plus (`frontend/src/pages/Plus.tsx`)

- Lede (unchanged): `a monthly or yearly pass, paid in wif.`
- `checkout can also settle in USDG or eth on wifly.` (when alt pay is live)
- Pay-token picker: **USDG**, **eth**, **wif**

### Plus fee row + InfoTip (Marv approved)

| Location | Before | After |
|----------|--------|-------|
| `FeeSplit` row label on Plus | `fee · 2%` | `burn · 2%` |
| Plus section InfoTip (`about plus payments`) | `paid to the wifly team. the 2% fee: 70% weekly pot, 10% burned.` | `paid to the wifly team. the 2% burn is 100% burned — nothing to the pot or treasury (same for USDG and eth checkout after swap-to-WIF).` |
| `FeeSplit` InfoTip body on Plus | `{splitLabel('fee')}. {pot} wif to the weekly pot, {burn} wif burned.` | `the full 2% is burned. nothing goes to the weekly pot or treasury.` |

## Names claim (`frontend/src/pages/Names.tsx`)

- CTA pattern: `claim {name}.wif for {amount} USDG` (or ETH via placeholder quote)

## Post boost (`frontend/src/sheets/Sheets.tsx`)

- `boost for ~{amount} USDG` / ETH variants via `formatPayQuote`

## Creator earnings (`frontend/src/pages/Earnings.tsx`)

- `plus, names and boosts can also settle in USDG or eth on wifly.`

## USDG asset

- Official token logo: `frontend/public/brand/usdg-token.svg`
- Source: Global Dollar (USDG) brand resources — token logo download ZIP at `https://framerusercontent.com/assets/llo5qqG8OQbvOU2QpFJPTdUyn0.zip` (also linked from [globaldollar.com/brand](https://globaldollar.com/brand) and [paxos.com/brand-resources](https://www.paxos.com/brand-resources))
- Token on Robinhood Chain: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, **6 decimals**
- ETH brand icon (checkout picker): `frontend/public/brand/eth-token.svg`

## `.wif` how it works copy (`frontend/src/pages/Names.tsx`, `WifHow` + claim InfoTip) — Marv approval

Only numeric / length edits (no free rewrite).

| Location | Before | After |
|----------|--------|-------|
| `WifHow` · your name, your wallet | `pick 3–20 characters (a–z, 0–9 and _).` | `pick 2–20 characters (a–z, 0–9 and _).` |
| `WifHow` · price body | ``${claimFeeOf('abcde')} wif to claim, or ${claimFeeOf('abc')} wif for short 3–4 character names.`` | ``${claimFeeOf('abcde')} wif for 5+ characters, ${claimFeeOf('abcd')} wif for 4, ${claimFeeOf('abc')} wif for 3, or ${claimFeeOf('ab')} wif for 2.`` |
| Claim InfoTip | `one-time. 3–4 letters … wif, 5+ letters … wif.` | `one-time. 2 letters 8,000 wif, 3 letters 4,000 wif, 4 letters 2,000 wif, 5+ letters 200 wif.` (amounts from `claimFeeOf`) |