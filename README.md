# Wifly

Wifly is a social tipping app on Robinhood Chain (chain ID 4663). People post, tip each other in $WIF, claim `.wif` names and earn badges. Fees feed a weekly jar. Each week the jar goes to the most-voted post and the people who voted for it.

Live app: https://app.wifly.fun

## How the money moves

- Tips carry a 2% fee. Fees on tips, votes and other payments go 90% to the weekly jar and 10% is burned.
- `.wif` name claims cost 100 WIF (5-20 characters) or 1,000 WIF (3-4 characters). Claim fees are split 50/50 between the treasury and the weekly jar.
- Fees on `.wif` name sales follow the same 90% jar / 10% burn split.
- Wifly Plus costs 1,500 WIF a month or 15,000 WIF a year.

## Repository layout

| Path | What it is |
| --- | --- |
| `backend/` | API server. Node 22, TypeScript, Hono, libSQL, viem, Redis (optional). |
| `frontend/` | Web app. Vite, React, wagmi, Privy. Served by Caddy in production. |
| `contracts/` | Solidity contracts (Foundry, solc 0.8.28, UUPS proxies). |
| `brand/` | Logo and brand assets. |
| `tools/` | Small helper scripts. |
| `docs/` | Deployment and swap notes. |

## Running locally

Requirements: Node 22, npm, and Foundry if you want to build the contracts.

Backend:

```sh
cd backend
cp .env.example .env
npm ci
npm run dev        # http://localhost:8787
```

Frontend:

```sh
cd frontend
cp .env.example .env
npm ci
npm run dev        # http://localhost:5173
```

Contracts:

```sh
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0 OpenZeppelin/openzeppelin-contracts-upgradeable@v5.1.0
forge build
forge test
```

## Tests

```sh
cd backend && npm test && npm run typecheck
cd frontend && npm run build    # type check, build, secret scan and CSP check
cd contracts && forge test
```

## Environment variables

Each package has a `.env.example` with defaults and comments. Never commit a real `.env`.

Backend: `PORT`, `NODE_ENV`, `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `REDIS_URL`, `RPC_URL`, `SESSION_SECRET`, `COOKIE_DOMAIN`, `COOKIE_SECURE`, `CORS_ORIGINS`, `ALLOWED_ORIGINS`, `SIWE_DOMAINS`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `WIFLY_CONTRACT_ADDRESS`, `NAMES_CONTRACT_ADDRESS`, `NAMES_RENDERER_ADDRESS`, `BADGES_CONTRACT_ADDRESS`, `DCA_CONTRACT_ADDRESS`, `CHAINLINK_ETH_USD`, `NAMES_CLAIM_FEE`, `NAMES_SHORT_FEE`, `NAMES_FEE_BPS`, `PLUS_CREATOR_ADDRESS`, `PLUS_PRICE_MONTH`, `PLUS_PRICE_YEAR`, `PRICE_TTL_MS`, `AGENT_ADDRESS`, `AGENT_PRIVATE_KEY`, `AGENT_SIGNER`, `AGENT_TX_ENABLED`, `ATTESTER_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`, `KEEPER_SIGNER`, `WIFLY_KEEPER_PRIVATE_KEY`, `WEEK_KEEPER_ENABLED`, `WEEK_KEEPER_INTERVAL_MS`, `DCA_KEEPER_ENABLED`, `DCA_KEEPER_INTERVAL_MS`, `DCA_KEEPER_MAX_SCAN`, `OPENROUTER_API_KEY`, `AI_MODELS`, `AI_DAILY_LIMIT`, `AI_PER_MINUTE`, `FREE_AI_MSGS_PER_DAY`, `GUEST_READS_PER_MIN`, `SIGNUP_PER_IP_HOUR`, `NEW_ACCOUNT_COOLDOWN_MIN`, `ALLOW_DEMO_SEED`, `RETIRE_ASS_HANDLE`.

Frontend: `VITE_APP_URL`, `VITE_SITE_URL`, `VITE_PRIVY_APP_ID`, `VITE_WALLETCONNECT_PROJECT_ID`, `VITE_WIFLY_ADDRESS`, `VITE_NAMES_ADDRESS`, `VITE_BADGES_ADDRESS`, `VITE_DCA_ADDRESS`, `VITE_WIFLY_AGENT_ADDRESS`, `VITE_WIFLY_TEAM_WALLET`, `VITE_ADMIN_ADDRESSES`, `VITE_TX_ENABLED`, `VITE_DEPLOY_PAGE`. The Caddy server also reads `API_UPSTREAM` and `SITE_ORIGINS`.

Contract scripts: `RH_RPC_URL`, `WIFLY_OWNER`, `WIFLY_TREASURY`, `WIFLY_KEEPER`, `WIFLY_ATTESTER`, `WIFLY_USE_BURN`, `WIFLY_TOP_SPOT_FLOOR`, `DEPLOY_NAMES`, `NAMES_CLAIM_FEE`, `NAMES_SHORT_FEE`, `NAMES_RESERVED`, `NAMES_RESERVE_TO`, `DEPLOY_BADGES`, `BADGES_URI`, `BADGE_THRESHOLDS`, `DEPLOY_DCA`. The deployer key is passed to `forge script` on the command line and is never stored in the repo.

## Contracts (Robinhood Chain, 4663)

| Contract | Address |
| --- | --- |
| Wifly (proxy) | [0x1eeB081a4529A2905Ea888948185ADa66c0619F5](https://robin.etherscan.io/address/0x1eeB081a4529A2905Ea888948185ADa66c0619F5) |
| WiflyNames (proxy) | [0x6270008BCd75868044ae7Eb7A3a0840625033477](https://robin.etherscan.io/address/0x6270008BCd75868044ae7Eb7A3a0840625033477) |
| Names renderer | [0x2d5cD6C8Fb375adb00Ea1411E87aeC09d044D4C9](https://robin.etherscan.io/address/0x2d5cD6C8Fb375adb00Ea1411E87aeC09d044D4C9) |
| WiflyBadges (proxy) | [0x28CA50899aC1b92fB3b2b7212ec8693BeD9F24d6](https://robin.etherscan.io/address/0x28CA50899aC1b92fB3b2b7212ec8693BeD9F24d6) |
| WiflyDca (proxy) | [0x3D1E4966f73e2dFf4f7A520Ce7E4d638cA55C109](https://robin.etherscan.io/address/0x3D1E4966f73e2dFf4f7A520Ce7E4d638cA55C109) |
| $WIF token | [0x5173b8eA6923c2d40267890D45C46a3480954773](https://robin.etherscan.io/address/0x5173b8eA6923c2d40267890D45C46a3480954773) |
| Treasury | [0x8E5f84738C0fb29670F370F73E53BD234CEfeF21](https://robin.etherscan.io/address/0x8E5f84738C0fb29670F370F73E53BD234CEfeF21) |
