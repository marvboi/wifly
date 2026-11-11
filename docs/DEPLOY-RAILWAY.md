# Wifly on Railway: deploy notes for peg

Env var **names only**. No values are in this repo. Marv sets every secret himself in the Railway dashboard.
Do not deploy until Marv says yes. Contracts are not deployed yet, so keep `TX_ENABLED` / `AGENT_TX_ENABLED` false.

## Services (one Railway project)

> Build/deploy settings now live in `.railway/railway.ts` (Railway Infrastructure as Code). The `railway.json` files below still work until Railway stops reading them on 2026-12-01; see `.railway/README.md` for the cut-over.

| service | root dir | config | port | healthcheck |
|---|---|---|---|---|
| `wifly-api` (Hono API) | `backend/` | `backend/railway.json` (Dockerfile builder) | `$PORT` (8787 locally) | `GET /healthz` (checks the DB; 200 = ok) |
| `wifly-web` (Vite build served by Caddy) | `frontend/` | `frontend/railway.json` (Dockerfile builder) | 8080 | `GET /` |
| Postgres | Railway plugin | n/a | n/a | n/a |
| Redis | Railway plugin | n/a | n/a | n/a |

* Name the API service `wifly-api`. The web Caddyfile proxies `/api` and `/uploads` to `http://wifly-api.railway.internal:8787` over private networking (override it with `API_UPSTREAM`). That keeps the session cookie first-party.
* Link previews: the web Caddyfile runs **no templates**. Crawler user agents asking for `/` or a page path are proxied to the api's `GET /api/og/page/<path>`, which returns a small html page with every value entity-encoded (unknown or odd paths fall back to the home card, always 200). People get the exact `dist/index.html` bytes. The CSP header is the same for both.
* Sign-out revokes the session token on the api (`revoked_sessions` table, rows dropped after they would have expired), then clears the cookie; the app empties its caches and device notes and reloads to `/`.
* Linking an x or a wallet that sits on another account: a real account (has a non-pending @name, plus, is onboarded, or has any activity, or its wallets hold ETH or $WIF) is never merged; the link answers 409 with that account's @name. Only an empty leftover is folded in (soft-deleted with a backup row). If the chain can't be read the link answers 503 "try again in a minute" instead of guessing.
* Only `wifly-web` needs a public domain. The API can stay private.
* `backend/railway.json` sets healthcheckPath `/healthz`, a 60 s timeout, restart ON_FAILURE ×5 and **1 replica** (preview default; raise it to 2 only with Turso + Redis). Shared state lives in the DB and Redis, and sessions are signed cookies.

## Database caveat (read first)

The API data layer is **libsql** (SQLite / Turso). `DATABASE_URL` takes `file:…` or a `libsql://` Turso URL; a Postgres driver is **not** wired in yet. Pick one of these:

1. **Turso** (works now): `DATABASE_URL=libsql://…` plus `DATABASE_AUTH_TOKEN`. You can raise numReplicas to 2 (with REDIS_URL set).
2. **Railway volume**: mount a volume at `/app/data`, set `DATABASE_URL=file:/app/data/wifly.db`, and **set numReplicas to 1** (SQLite file, single writer).
3. **Railway Postgres plugin**: add it now (`DATABASE_URL=${{Postgres.DATABASE_URL}}`), but the API needs a Postgres adapter for `db.ts` first. That is still open.

Migrations run on boot (`migrate()`; additive `ALTER`s, including `names.theme`).

## Before contracts are live (no demo data)
Leave every contract address empty and TX_ENABLED, AGENT_TX_ENABLED, WEEK_KEEPER_ENABLED, DCA_KEEPER_ENABLED false (or unset). The site then shows only real data, or empty states.

* Set `NODE_ENV=production` on wifly-api. The server has no demo seeding at all (speed.11 removed `SEED_ON_EMPTY`, `npm run seed` and `demo-activity`; test fixtures live in `backend/test/fixtures`).
* Do **not** set `ALLOW_DEMO_SEED` on the live service. `ALLOW_DEMO_SEED=1` exists only for a throwaway staging database.
* If an old database still holds seed rows, `npx tsx src/purge-seed.ts` removes them (rows marked `seed = 1`). Purge is allowed in production.
* The API returns no made-up numbers: no seed follower counts, no seed burns or badges, no seed Plus, and no `demo` flags on listings, badges or Plus.

## Domains: wifly.fun (landing) and app.wifly.fun (app)

One `wifly-web` build serves both hosts and picks the role from the host name:

| host | `/` shows | other routes |
|---|---|---|
| `wifly.fun` (and `www.wifly.fun`) | landing page | app routes redirect to `https://app.wifly.fun/…` |
| `app.wifly.fun` | the feed | `/home` redirects to `/` |
| anything else (e.g. `wifly-web-production.up.railway.app`) | single-host behaviour, as before | unchanged |

Steps:
1. **Railway → wifly-web → Settings → Networking → Custom Domain:** add `wifly.fun` and `app.wifly.fun` (optionally `www.wifly.fun`). Railway shows a CNAME target for each (something like `xxxx.up.railway.app`) and a TXT verification record. Keep the Railway URL too.
2. **Spaceship → wifly.fun → DNS records:**
   * `app` → **CNAME** → the target Railway shows for app.wifly.fun.
   * apex `@` → the record Railway shows for wifly.fun. Use **ALIAS/ANAME** (CNAME flattening) if Spaceship offers it at the apex; a plain CNAME is not allowed at `@` alongside other records.
   * `www` → CNAME → the Railway target for www (if added).
   * Add the **TXT** verification records Railway lists (`_railway-verify…`) exactly as shown.
   * Remove any parking/URL-redirect records on `@` or `app` first. Wait for Railway to show the domains as verified and for the certificates to be issued.
3. **Privy dashboard → your app → Settings → Domains / Allowed origins:** add `https://wifly.fun`, `https://app.wifly.fun` and keep `https://wifly-web-production.up.railway.app`. Sign-in fails with an iframe/origin error on any host that is not listed. (Our own CSP is not the cause: web pages allow framing only by `'self'` + these hosts.)
4. **wifly-web build args:** `VITE_SITE_URL=https://wifly.fun`, `VITE_APP_URL=https://app.wifly.fun` (the Dockerfile defaults to these). Leave both empty for single-host behaviour. Redeploy after changing them (build-time values).
5. **wifly-web runtime:** `SITE_ORIGINS` (space-separated) feeds the CSP in the Caddyfile. Default: `https://wifly.fun https://app.wifly.fun https://wifly-web-production.up.railway.app`. The request's own host is always covered by `'self'`.
6. **wifly-api runtime:** `ALLOWED_ORIGINS=https://wifly.fun,https://app.wifly.fun,https://wifly-web-production.up.railway.app` (comma-separated, full origins). It drives CORS, the SIWE sign-in check (message domain must be one of these hosts and its URI one of these origins), and the session cookie (`Secure` for these https origins). Unset: the Railway URL only in production, the Vite dev ports locally. `CORS_ORIGINS` is still read if `ALLOWED_ORIGINS` is unset; `SIWE_DOMAINS` overrides the domain list if set.
   * The session cookie is **host-only** by default: signing in on app.wifly.fun does not sign you in on the Railway URL. That is intended (the landing page needs no session). Set `COOKIE_DOMAIN=wifly.fun` only if wifly.fun itself must share the session.

## Redis
Use `REDIS_URL=${{Redis.REDIS_URL}}`. It holds the shared price cache, rate limits and SSE fan-out across replicas. Empty means in-memory, which is single-instance only.

## Env var names

**wifly-api** (runtime):
`PORT` (Railway injects it), `DATABASE_URL`, `DATABASE_AUTH_TOKEN` (Turso only), `REDIS_URL`, `NODE_ENV=production`, `SESSION_SECRET` (Marv), `ALLOWED_ORIGINS`, `SIWE_DOMAINS` (optional), `COOKIE_DOMAIN` (optional), `COOKIE_SECURE=1`, `TIP_FEE_BPS` (200),
`RPC_URL`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET` (optional, Marv; JWKS verification works without it), `PRIVY_VERIFICATION_KEY` (optional),
`ATTESTER_PRIVATE_KEY` (Marv), `WIFLY_CONTRACT_ADDRESS`, `NAMES_CONTRACT_ADDRESS`, `NAMES_RENDERER_ADDRESS`, `BADGES_CONTRACT_ADDRESS`,
`PLUS_CREATOR_ADDRESS`, `PRICE_TTL_MS`, `CHAINLINK_ETH_USD`, `PLUS_PRICE_MONTH`, `PLUS_PRICE_YEAR`, `NAMES_FEE_BPS`, `NAMES_CLAIM_FEE`, `NAMES_SHORT_FEE`,
`AGENT_PRIVATE_KEY` (Marv, Railway only, never printed), `AGENT_SIGNER`, `AGENT_ADDRESS`, `AGENT_TX_ENABLED` (false).
`WEEK_KEEPER_ENABLED` (false), `WEEK_KEEPER_INTERVAL_MS` (default 600000), `KEEPER_SIGNER`, `KEEPER_PRIVATE_KEY` (Marv, Railway only; falls back to the agent signer),
`TURNSTILE_SITE_KEY` (public), `TURNSTILE_SECRET_KEY` (Marv; both unset = no challenge), `NEW_ACCOUNT_COOLDOWN_MIN` (10), `SIGNUP_PER_IP_HOUR` (5), `GUEST_READS_PER_MIN` (120).

**wifly-web** (build args; public values only, never a secret in a `VITE_` var):
`VITE_PRIVY_APP_ID`, `VITE_WIFLY_ADDRESS`, `VITE_NAMES_ADDRESS`, `VITE_BADGES_ADDRESS`, `VITE_WIFLY_AGENT_ADDRESS`, `VITE_WIFLY_TEAM_WALLET`, `VITE_TX_ENABLED` (false), `VITE_WALLETCONNECT_PROJECT_ID` (optional, public), `VITE_SITE_URL`, `VITE_APP_URL`, and runtime `API_UPSTREAM` (optional), `SITE_ORIGINS` (optional).

The full commented lists are in `backend/.env.example` and `frontend/.env.example`. `npm run build` fails if a server secret leaks into the frontend bundle (check-secrets.mjs).

## Week keeper (creator of the week)

`finalizeEpoch(epoch, winner)` on Wifly is permissionless; the keeper (backend/src/keeper.ts) just calls it once a week has ended.
- Off until `WEEK_KEEPER_ENABLED=true` (keep false until contracts are live and Marv says go). Needs `WIFLY_CONTRACT_ADDRESS` and a signer.
- Signer: `KEEPER_PRIVATE_KEY` if set (Marv pastes it in Railway; never in chat or code), else the agent signer. Gas only, it holds no WIF.
- Runs every `WEEK_KEEPER_INTERVAL_MS`. It simulates first and skips weeks that are already finalized or had no votes (NoVotes rolls the pot over).
- Status: `GET /api/vote/keeper`.
- Run it on ONE replica only (one api service, or a separate worker with the flag on). Two keepers just race; the loser reverts with AlreadyFinalized and wastes gas.

## Sign-up friction

- Turnstile runs only when an account is created (re-auth sends no token). With both keys unset there is no challenge. CSP already allows challenges.cloudflare.com.
- Honeypot field `website`, per-IP and per-identity sign-up limits, a 10-minute cooldown on links and tips for new accounts, and a rate limit on guest reads (guests see 8 items per list).

## Contract deploy → app wiring (after Marv says yes; fresh deploy wallet, Marv holds the key)
1. Deploy WiflyGlyphs → WiflyNameRenderer → WiflyNames(wif, useBurn, owner, treasury, claimFee, shortClaimFee) → Wifly(wif, useBurn, owner, attester, treasury, topSpotFloor) → Badges(wif, useBurn, owner, uri, thresholds).
   The treasury is `0x8E5f84738C0fb29670F370F73E53BD234CEfeF21`.
2. Call **`WiflyNames.setPot(<Wifly address>)`**. Without it, the names pot share (50% of claims, 90% of sale fees) goes to the treasury.
3. Set the addresses above (API `*_CONTRACT_ADDRESS`, `NAMES_RENDERER_ADDRESS`; web `VITE_*_ADDRESS`), then redeploy web (build-time values).
4. Re-run `cd contracts && forge build`, then `cd frontend && npm run abi` and `node tools/export-renderer.js` if the sources changed.
5. Flip `VITE_TX_ENABLED` / `AGENT_TX_ENABLED` only when Marv says go.

## Checks before going live
* `GET /healthz` on wifly-api (private: `curl http://wifly-api.railway.internal:8787/healthz`) returns `{"ok":true}`. CSP is on both services; the API sends `X-Frame-Options: DENY`, the web sends `SAMEORIGIN` with `frame-ancestors 'self'` + the site origins (`npm run check:csp`).
* `curl -sI https://app.wifly.fun/home` → redirect to `/`; `curl -sI https://wifly.fun/vote` → redirect to `https://app.wifly.fun/vote`.
* `GET /api/feed` on a fresh production database returns an empty list (no seed rows).
* Load test: `node tools/loadtest.js` (autocannon) reports rps and p95.
