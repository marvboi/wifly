# Flat price table (old vs new)

Values are in WIF unless noted. **PROPOSED** rows are suggestions only; they are not changed in code on this branch except the name tiers below.

## .wif name claims (onchain)

| Length | Old | New (Marv approved) |
|--------|-----|---------------------|
| 5+ chars | 100 | 200 |
| 4 chars | 1,000 | 2,000 |
| 3 chars | 1,000 (short tier) | 4,000 |
| 2 chars | closed | 8,000 |

## Wifly Plus

| Plan | Old | New |
|------|-----|-----|
| Monthly | 1,500 / 30 days | 1,500 / 30 days |
| Yearly | 15,000 / 365 days | 15,000 / 365 days |

## Top Spot / post boost

| Item | Old | New |
|------|-----|-----|
| Minimum bid (floor) | 100 WIF | 100 WIF |
| Raise step | 10% over current | 10% over current |

## Votes

| Item | Old | New |
|------|-----|-----|
| Per vote | 10 WIF | 10 WIF |

## Marketplace / fees

| Item | Old | New |
|------|-----|-----|
| .wif resale fee | 2.5% | 2.5% |
| Platform fee (tips, plus, unlocks, etc.) | 2% | 2% |

## Payment methods (new)

| Product | WIF | USDG | ETH |
|---------|-----|------|-----|
| Plus | yes | yes (router) | yes (router) |
| Name claim | yes | yes (router) | yes (router) |
| Post boost | yes | yes (router) | yes (router) |

USDG token address is owner-set on `WiflyPayments`; not hardcoded (blocker until treasury publishes it).

## PROPOSED raises (not implemented)

| Item | Current | PROPOSED | Reason |
|------|---------|----------|--------|
| Vote price | 10 WIF | 15 WIF | Crowd votes are cheap versus name tiers; a small bump keeps spam down while staying accessible. |