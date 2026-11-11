# Burn badge art (for peg)

**WiflyBadges does not render SVG onchain.** It is an ERC-1155 that uses `uri` / `setURI` (event `URISet`), and badge ids are
0-based (`thresholds[i]`). So no change to `contracts/src` is needed or made. This is a proposal only.

## What ships in the app

- `frontend/src/lib/medal.ts`: one SVG generator for all four tiers. The app's `<BadgeArt/>` and the static files both use it.
  | id | tier | burned | material | rim teeth |
  |---|---|---|---|---|
  | 0 | first light | 1,000 | bronze | 12 |
  | 1 | flat earther | 10,000 | silver | 16 |
  | 2 | edge walker | 100,000 | gold | 20 |
  | 3 | the disc | 1,000,000 | emerald-lime | 24 |
- Each medal has a notched rim, a bevel, an engraved ember over the flat-world disc, and the amount (1K / 10K / 100K / 1M) stamped at
  the bottom. It uses only linear gradients, with no filters or glows, so it stays crisp at any size (checked at 32 px and 168 px).
  Each medal is 3.3 to 3.8 KB.
- `npm run badges:svg` (in frontend) writes:
  - `public/badges/<tier>.svg` and `<tier>-locked.svg`
  - `public/badges/meta/<64-hex id>.json` (ERC-1155 metadata: name, description, image, attributes)

  Run it with `BADGE_BASE_URL=https://<app host>` before the deploy so `image` is an absolute URL.

## Proposal

1. At deploy time, pass `uri_ = "https://<app host>/badges/meta/{id}.json"` to the WiflyBadges constructor, or call
   `setURI` later. This needs no contract change.
2. Optional, and only if peg wants fully onchain art: a `WiflyBadgeRenderer` like `WiflyNameRenderer` that returns these
   SVG strings as `data:` URIs, wired through a new `uri(id)` override. Each SVG is under 4 KB, so all four fit comfortably in one
   contract (under 24 KB). That would be a peg change to `contracts/src` plus new tests, so it is not done here.
