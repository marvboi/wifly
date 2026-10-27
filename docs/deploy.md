# Deploying

Two services, each with its own Dockerfile and `railway.json`:

| service | root | port | health check |
|---|---|---|---|
| `wifly-api` (Hono on Node 22) | `backend/` | `$PORT` (8787 locally) | `GET /healthz` |
| `wifly-web` (Vite build served by Caddy) | `frontend/` | 8080 | `GET /` |

The Caddyfile proxies `/api` and `/uploads` to `http://wifly-api.railway.internal:8787` (override with `API_UPSTREAM`),
so the session cookie stays first-party. Only `wifly-web` needs a public domain.

## Database

The data layer is libsql. `DATABASE_URL` takes a `file:` path (mount a volume and run one replica) or a `libsql://` Turso
URL with `DATABASE_AUTH_TOKEN`. Migrations run on boot. `REDIS_URL` is optional; without it the cache, rate limits and SSE
fan-out are in memory, which only works on a single instance.

The server never seeds demo data. `ALLOW_DEMO_SEED` exists for throwaway staging databases only.

## Domains

One web build serves both hosts and picks the role from the host name:

- `wifly.fun`: landing page; app routes redirect to `https://app.wifly.fun/...`
- `app.wifly.fun`: the app

Build args `VITE_SITE_URL` and `VITE_APP_URL` set the two hosts. `SITE_ORIGINS` (web) and `ALLOWED_ORIGINS` (api) must list
every origin the app is served from; they drive the CSP, CORS, the SIWE domain check and the cookie. Add the same origins in
the Privy dashboard.

## Keepers

- Week keeper (`WEEK_KEEPER_ENABLED`): calls `Wifly.finalizeEpoch` once a week has ended. The call is permissionless; the
  keeper only pays gas. Run it on one replica.
- DCA keeper (`DCA_KEEPER_ENABLED`): calls `WiflyDCA.executeBatch` for due plans. Its address needs
  `WiflyDCA.setKeeper(addr, true)`.

Signing keys (`ATTESTER_PRIVATE_KEY`, `AGENT_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`, `WIFLY_KEEPER_PRIVATE_KEY`) are set in the
hosting env only. `npm run build` in `frontend/` fails if a server secret ends up in the bundle.

## Contracts

`contracts/script/DeployWifly.s.sol` deploys everything behind ERC1967 proxies (the renderer is plain) and wires it up:
`setRenderer`, `setPot(wifly)`, reserved names and the DCA keeper. The admin-only `/deploy` page in the app does the same
steps from a browser wallet when `VITE_DEPLOY_PAGE=true`.

After a contract change:

```sh
cd contracts && forge build
cd ../frontend && npm run abi          # ABIs + deploy artifacts
cd .. && node tools/export-renderer.js # renderer bytecode for name previews
```

## Badge art

WiflyBadges is an ERC-1155 that serves metadata from `uri`. `npm run badges:svg` in `frontend/` writes the medal SVGs and
`public/badges/meta/<id>.json`; set `BADGE_BASE_URL` first so the image links are absolute.
