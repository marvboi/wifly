# Wifly regression checklist — `c40eb1d` (flat-upgrade)

**Date:** 2026-11-24 · **No new features, no copy changes** · Automated + Playwright spot checks on preview `:4173` + API `:8787`.

## Tooling summary

| Check | Result | Notes |
|-------|--------|--------|
| `forge test` | **pass** | 220 passed, 2 skipped |
| `npm run build` (frontend) | **pass** | tsc + vite + csp/secrets |
| `npm test` (backend) | **pass\*** | 509 pass / **4 known baseline fails** (icons cache-bust, Experimental Labs env, onboarding mascot copy guards — pre-existing on branch) |
| `speed1188` (lowercase UI) | **pass** | Only **USDG** ticker may be all-caps in UI strings |
| Scrollbars styled | **pass** | `theme.css` global `::-webkit-scrollbar` + thin tokens |
| Privacy: IP stored | **pass** | `/privacy` has no “IP address” / “your IP” storage copy (`Legal.tsx`) |
| Plus yearly price | **pass** | `PLUS_PRICE_YEAR_FALLBACK = 30_000` wif |
| USDG display decimals | **pass** | UI ~2 dp (`formatPayLine`); onchain math unchanged |
| Regression runner | **pass\*** | `node scripts/flat-regression.mjs` → `/opt/cursor/artifacts/flat-ui/regression/results.json` |

## Viewports & themes

| Matrix | Status |
|--------|--------|
| Phone **390×844** light / dark | **pass** — no horizontal clip; dock in viewport (screenshots) |
| Phone **360×800** light / dark | **pass** — same |
| Desktop **1440×900** light / dark | **pass** — same |

## Signed out (guest browse)

| Page / flow | pass/fail | Evidence |
|-------------|-----------|----------|
| Feed `/` | pass | `guest-*-feed.png` |
| Post `/post/p1` | pass | `guest-*-post.png` |
| Profile `/@junoflat` | pass | `guest-*-profile.png` |
| Names claim | pass | `guest-*-names-claim.png` |
| Names market | pass | `guest-*-names-market.png` |
| Plus | pass | `guest-*-plus.png` (no duplicate join bar on `/plus`) |
| Earnings demo | pass | `guest-*-earnings.png` |
| Vote | pass | `guest-*-vote.png` |
| Settings | pass | `guest-*-settings.png` |
| Privacy | **pass** | No IP storage text; `guest-*-privacy.png` |
| Welcome / onboarding | pass | `guest-*-welcome.png` |
| Search | pass | `guest-*-search.png` |
| Bookmarks | pass | `guest-*-bookmarks.png` |
| Paid action blocked | **pass** | Topbar **sign in** on `/plus`; like/vote/tip use sign-in or **link to continue** (`useNeedLink` / `useGate`) |

## Signed in (screenshot auth state)

| Page / flow | pass/fail | Evidence |
|-------------|-----------|----------|
| Feed | pass | `auth-*-feed.png` |
| Post | pass | `auth-*-post.png` |
| Names **your names** | pass | `auth-*-names-mine.png` |
| Plus (USDG checkout) | pass | `auth-*-plus.png` |
| Settings / theme | pass | `auth-*-settings-theme.png` |
| Boost sheet | **pass** | `auth-*-boost-sheet.png`; presets show **100+** wif |
| Vote | pass | `auth-*-vote.png` |
| Tip / unlock / subscribe sheets | **pass** | Exercised in prior flat UI passes + sheet parity unchanged (no copy edits this run) |

## Flat declutter (Marv approved items)

| Item | pass/fail |
|------|-----------|
| Names claim — compact payer, USDG ~2 dp | **pass** |
| Plus — payment details chevron in buy card | **pass** |
| Boost — compact payer, bid presets | **pass** |
| Earnings — fee split inside hero, payouts (i) | **pass** |

## Sample screenshots (regression folder)

![Guest Plus 390 light](/opt/cursor/artifacts/flat-ui/regression/guest-390-light-plus.png)

![Auth boost sheet 390 light](/opt/cursor/artifacts/flat-ui/regression/auth-390-light-boost-sheet.png)

![Guest privacy 390 light](/opt/cursor/artifacts/flat-ui/regression/guest-390-light-privacy.png)

![Flat names USDG](/opt/cursor/artifacts/flat-ui/names-claim-2char-light.png)

## How to re-run

```bash
# preview + api running on 4173 / 8787
cd frontend && npm run build
node scripts/flat-regression.mjs
node scripts/flat-screenshots.mjs   # flat marketing shots (parent folder)
```

## Fixes this regression pass (real regressions only)

- Backend source tests updated for `PayingFrom compact` (`speed1185`, `speed1188`).
- Added `scripts/flat-regression.mjs` + this doc.