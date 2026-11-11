# Wifly: contract spec and wiring report

Status date: 26 Oct 2026 (feev2 sync). Contracts are NOT deployed. TX_ENABLED=false and AGENT_TX_ENABLED=false. Deploying waits for Marv's yes; he holds the fresh deploy wallet key.
Wifly is not affiliated with Robinhood. $WIF here means World Is Flat.

## Chain and token
- Robinhood Chain, id 4663. Explorer: robinhoodchain.blockscout.com
- $WIF: 0x5173b8eA6923c2d40267890D45C46a3480954773
- Treasury: 0x8E5f84738C0fb29670F370F73E53BD234CEfeF21
- Get $WIF swap:
  - ETH↔WIF goes through the v4 Quoter and executes via the Universal Router at 0x8876789976decbfcbbbe364623c63652db8c0904.
  - The quote includes the "1% pool fee".
  - Approvals: Permit2 exact-amount approve, then a 30-minute allowance.
  - Slippage presets 0.5 / 1 / 3. The quote refreshes every 10 s and the swap is simulated before sending.
  - Kyber is used only when it beats the direct route.
  - Plus top-up is exact-out (about 1,520 WIF) with about a 1.3% buffer.
  - Details: swap/SWAP.md.

## Fee rule (feev2, Oct 26)
Every fee splits **90% community pot / 10% burned** (`POT_BPS` 9000 / `BURN_BPS` 1000). The treasury gets nothing from fees.
- Covered fees: tips 2%, subscriptions 2%, unlocks and paid content 2%, name sales 2.5%, promotion (Top Spot) fees, votes.
- **.wif name claims are the exception:** 50% treasury / 50% community pot, no burn (`CLAIM_TREASURY_BPS` / `CLAIM_POT_BPS` 5000). Claim fee 100 WIF, or 1,000 WIF for 3–4 character names.
- Badge burns are not a fee: they stay **100% burned**.
- Top Spot: the outbid holder gets 90% back (`TOP_SPOT_PREV_BPS` 9000); the other 10% goes through the fee split. A bid on an empty spot is all fee.
- Max fee: `MAX_FEE_BPS` 500 (5%) on Wifly.
- Onchain:
  - `Wifly._splitFee`: `epochPot += 90%` (plus rounding dust), `_burn(10%)`, emits `FeeSplit(potAmount, burnAmount)` (2 fields, new topic0 `0xe3d1bc95…65ee4d`; the names 3-field one is `0x3a8a61c6…522491`).
  - `WiflyNames`: sale fee 90% pot / 10% burned (`SALE_POT_BPS` / `SALE_BURN_BPS`); claims 50/50 treasury/pot. The pot share goes to Wifly via `approve + fundPot`; if `pot` is unset it goes to the treasury. `FeeSplit(treasury, pot, burn)` keeps 3 fields here.
  - **After deploying, call `WiflyNames.setPot(<Wifly>)`.**
- The community pot (`epochPot` / `communityPot()`) is only spent by `finalizeEpoch` / `claimVoterReward`. `finalizeEpoch` splits `payablePot()` = `epochPot` minus what arrived this week (`potInCurrent` / `potInEpoch`), 50% winner / 50% voters.

## Contracts and ABIs (peg's, re-pulled after his fee update)
ABIs regenerated from peg's final feev2 build (`ABI_OUT=/workspace/wifly-contracts-feev2/contracts/out npm run abi`):
- Wifly: 200 entries
- WiflyNames: 152 entries
- WiflyBadges: 75 entries (unchanged)

### Wifly
`initialize(wif, useBurnFunction, owner, attester, treasury, topSpotFloor)` (UUPS proxy, see below)

- **quoteFee:** `quoteFee(amount) → (fee, potPart, burnPart, net)` (`useQuoteFee`).
- **quoteSplit:** `quoteSplit(fee) → (potPart, burnPart)`. Fee breakdowns read it through `useQuoteSplit` when live; claims read `WiflyNames.quoteClaimSplit`.
- **Pot views:** `payablePot()` (what the next `finalizeEpoch` pays), `potInCurrent()`, `potInEpoch()`, `communityPot()` / `epochPot()`. The app shows `epochPot()` as the jar (running total). `payablePot()` is only for the keeper's finalize and anything labelled "paid at week close"; the companion shows both ("in the jar now" / "paid at week close").
- **Unchanged:** `treasury`, `setTreasury`, `fundPot`, and `initialize`. `TREASURY_BPS` is gone.
- **Agent API:** these all spend only from the user's deposited `balances`, within the agent's daily cap.
  - `setAgent(agent, uint128 dailyCap)`
  - `revokeAgent()`
  - `agents(user)`
  - `agentRemaining(user)`
  - `balances(user)`
  - `deposit(amount)` / `withdraw`
  - `tipFor(user, creator, amount, postId)`
  - `subscribeFor(user, creator, tier)`
  - `subscribeForPlan(user, creator, tier, plan)`
  - `takeTopSpotFor(user, postId, amount)`
- **Events:** `FeeSplit(potAmount, burnAmount)` (2 fields; nothing in the app decodes it), Tipped, Subscribed, Unlocked, Paid, TopSpotTaken, AgentSet, AgentSpent, Burned, PotFunded, …
- **Server signer:** `AGENT_PRIVATE_KEY` is server-side only, behind a signer interface (backend/src/agent). Marv sets it in Railway. It is never printed and never in code.

### WiflyNames ("WIF Names" / WIFNAME, ERC-721 + Multicall)
`initialize(wif, useBurnFunction, owner, treasury, claimFee, shortClaimFee)` (UUPS proxy)

- **Names:** 3–20 characters of [a-z0-9_].
- **Reserved:** wifly, marv and wif (team `reserve()`; `lockReservations()`).
- **Functions:**
  - claim, setPrimary
  - `setAddr(tokenId, a)` / `setText(tokenId, key, value)`: key is 1–64 bytes; value (bio) is at most 256 bytes. These can be batched with `multicall`.
  - list / cancel / `buy(tokenId, maxPrice)`
  - resolve("x.wif"), addr, text, reverseName, nameOf, isAvailable, claimFeeOf
  - `quoteSale(price) → (fee, potPart, burnPart, net)`
  - `quoteSplit(amount) → (potPart, burnPart)`, `quoteClaimSplit(amount) → (treasuryPart, potPart)`
  - setPot / setRenderer / lockRenderer
  - tokenURI (onchain renderer): `renderer.tokenURI(id, name, rare (≤4 chars), isReserved[id], theme[id])`
  - **Card theme:** `setTheme(id, uint8 t)`, token owner only (`NotNameOwner`), `t ≤ MAX_THEME` (2), else `BadTheme`. 0 = default (rare green, others white), 1 = white, 2 = green. `theme(id)` reads it. Emits `ThemeSet(id, t)` and `MetadataUpdate(id)` (ERC-4906). It is kept on sale/transfer and works inside `multicall`.
- **Records reset on transfer:** `RecordsCleared(tokenId, version)`. The UI shows a warning before list or buy.
- **Theme in the app:**
  - The claim step (onboarding and .wif hub) has a White / Green picker with live onchain-rendered thumbnails. The default is green for ≤4 chars, white otherwise.
  - A non-default pick appends `setTheme(id, t)` to the claim multicall (claim + setAddr + setTheme, one tx).
  - Manage name has the same picker plus a save button that sends one `setTheme` tx.
  - The backend mirrors the theme in `names.theme`: `/api/names/claim {theme}`, `POST /api/names/:name/theme {theme, txHash}` (owner only; needs a tx hash when live), and `/sync` re-reads `theme(id)` after a sale.
  - The art route takes `?t=0|1|2`; without it, the stored theme is used.
- **ABI change to note:** `NameClaimed(tokenId, name, owner, fee)` replaced the old fee-burned field, and `FeeSplit` and `PotSet` were added.
  - The frontend and backend did not decode the old field, so nothing broke.

### WiflyNameRenderer (contracts/src/render)
- Name previews use the onchain SVG. Its bytecode runs in-process (@ethereumjs/evm) at `/api/names/art/:file`.
- Set `NAMES_RENDERER_ADDRESS` to switch to a live chain read.
- **Design C** with themes: `svg(name, rare, reserved)` and `svg(name, rare, reserved, uint8 theme)`, with green = `theme==2 || (theme!=1 && rare)`.
- renderer.json was re-exported from contracts/out at the end of this round (renderer 16,596 B, glyphs 10,975 B). It comes from WiflyNameRenderer.sol of 15:40 UTC.
- Every name preview uses it: the claim card, picker thumbnails, the market and your-names row thumbnails, the market expanded card, manage and the public page. The design-A previews came from the old renderer.json still loaded by the running backend; it has been restarted.
- Re-pull with `forge build`, then `node tools/export-renderer.js`, then restart the API.
- Note: marv is in our reserved set, so its art shows the reserved style. peg's forge preview used reserved=false for marv. With reserved=false the output is byte-identical.

### WiflyBadges
`initialize(wif, useBurnFunction, owner, uri, thresholds)` (UUPS proxy)

- Thresholds: 1k / 10k / 100k / 1M WIF.
- Soulbound; badge burns are 100% burned.
- The burn sheet waits for the receipt before it animates.

### WiflyDCA (ABI: frontend/src/contracts/wiflyDca.ts)
- Each user funds their own plan with ETH (`createPlan(PlanParams, startAt)`, `cancelPlan`, top-up / withdraw). No platform fee: the only costs are the pool's 1% hook cut and an optional `keeperTip` (≤ `amountPerBuy`, default 0).
- Limits: `MIN_INTERVAL` 1 hour, `MAX_SLIPPAGE_BPS` 1,000 (10%). The contract re-checks the keeper's `minWifOut` against an onchain V4Quoter quote, so a keeper cannot pass a lax minimum.
- Keeper: `execute(planId, minWifOut)` / `executeBatch`, allowlisted by `setKeeper(keeper, true)` (owner only, emits `KeeperSet`). The deploy script calls it only when a keeper address is given and the deployer is the owner; with the default owner (treasury) **the treasury must call `WiflyDCA.setKeeper(<keeper address Marv chooses>, true)` after deploying.** No keeper address is invented here.
- App: `/dca` sets amount, cadence (every day/week, weekday and time), deposit and price floor; plans list with pause/cancel. Creating a plan is free for everyone; the **backend keeper only runs plans for Plus members** (below). `DCA_KEEPER_ENABLED=false` and `KEEPER_PRIVATE_KEY` / `WIFLY_KEEPER_PRIVATE_KEY` are Marv's (never in chat or code).
- Companion: the fuzzy command parser (backend/src/commandParse.ts) understands typos like "by 5 wif evry mondy" and turns them into a DCA draft the user confirms in the app.

## Wifly Plus gate (backend/src/plusGate.ts)
- Price: 1,500 WIF a month or 15,000 WIF a year (`subscribeForPlan` to the team creator).
- Reads `Wifly.subStatus(user, team)`. Access while the period runs **or inside the 5-day grace**. A failed read **denies** (fail closed) with a "couldn't check Plus right now" reason.
- Preview (contracts not deployed): the app mirror `plus_subs` uses the same active/grace rule, so the demo states `/plus?state=active|grace|expired|price` work without a tx.
- Plus-gated: companion agent commands (tip, subscribe, Top Spot, DCA through the agent) and the DCA keeper. Free for everyone: chat itself, the swap, names, badges and creating a DCA plan.

## Companion
- Chat runs on **free OpenRouter models only**, for free and Plus users alike (no paid models). Header label "Free AI assistant"; it introduces itself as "I'm Wifly's free assistant." `OPENROUTER_API_KEY` is Marv's.
- "Rent an AI agent" card on /plus and in the companion's "my agent" tab: **Coming soon** (no checkout, no contract call).

## UUPS proxies, /deploy and verification
- script/DeployWifly.s.sol deploys each implementation, then an `ERC1967Proxy(impl, initialize-calldata)` in the same tx (no front-run of `initialize`). Proxies: Wifly, WiflyNames, WiflyGlyphs, WiflyBadges, WiflyDCA, plus the renderer and the wiring calls (`setPot`, `setRenderer`).
- Upgrade rights: `owner` defaults to the **treasury** address (0x8E5f…eF21; override with `WIFLY_OWNER`), so upgrades and the owner-only wiring need the treasury wallet unless the deployer is the owner.
- `/deploy` (admin only: `VITE_ADMIN_ADDRESSES` + `VITE_DEPLOY_PAGE`) runs the same order from the connected wagmi wallet (Privy embedded wallets are not used there). Note for peg: the page deploys in its own step order; the result is the same set of proxies and wiring.
- The collapsed **Verification** section lists per contract: proxy, implementation, both tx hashes and blocks, `initialize` calldata, proxy constructor args (abi-encoded `(address, bytes)`), implementation constructor args `0x`, compiler notes (solc 0.8.28, optimizer 200 runs, evm cancun). **Download deployments.json** and **copy JSON** buttons. Nothing is filled until real txs exist; no addresses or hashes are made up.
- Nothing has been deployed. Deploy waits for Marv's yes.

## Free @name + optional .wif (Marv 5:20, peg 5:21, Marv 5:30)

- Sign-up gives a **free @name**: a DB row (`users.handle`, `COLLATE NOCASE`, unique, same charset as .wif: 3–20 of `[a-z0-9_]`). Not an NFT, no wallet or WIF needed.
- Right after the @name, one optional step: **"Want name.wif too?"** with live availability + claim fee, the design C card preview with the white/green pick, **Claim it** (`multicall([claim, setTheme?, setAddr, setPrimary])`, one tx) and **Maybe later**. If the .wif is already held onchain it says so gently and shows close alternatives.
- **Reservation case: none.** `WiflyNames.claim(string)` takes no attester signature, so anyone can claim any .wif. Sign-up blocks a free @name whose .wif is already owned (`reason: 'wif-owned'`); there is no first dibs and no "reserved for you" copy.
- Free @name holders see **"Claim name.wif before someone else does"** (home + own profile + settings, "make it yours onchain" button) via `GET /api/me/identity`.
- **Owning x.wif wins @x.** If someone else claims it, the free holder gets a `handle_bump` notice: posts, followers and badges stay, only the handle changes. 7-day grace (`GRACE_MS`) with a rename step; after that `settleBumps` moves them to `x_N` and the owner gets @x (when x.wif is their main name). With nobody on @x, `/@x` redirects to the .wif owner.
- .wif owners keep: name switch (`POST /api/me/name`), "formerly @old" label, old-link redirects, "pick your main name" (Names → your names → set as primary). Their @ follows their main .wif (`PATCH /api/me` handle → 409 for them).
- Wallets: Privy embedded (X/email) and external (MetaMask, Rabby via EIP-6963 detection, WalletConnect when `VITE_WALLETCONNECT_PROJECT_ID` is set) sign through the same path (`useAnyAccount` + `privyBridge.sendTx` when no wagmi wallet). Privy deprecated its `rabby_wallet` list entry, so Rabby shows as a detected wallet.
- Postgres note: the app runs on libsql/SQLite. A Postgres adapter needs `citext` or a unique index on `lower(handle)` (and on `handle_bumps.handle`).

## Items for peg
- feev2 synced. contracts/ in this repo is a copy of /workspace/wifly-contracts-feev2/contracts (src, test, script, README, docs/WIF-NAMES.md).
- Weekly keeper (backend, off unless `WEEK_KEEPER_ENABLED=true`): finalizes each ended week once, skips closed or empty weeks, logs `payablePot()` with each run.

## Privy
- App ID cmvnw430g01i40gjsciab3wce (public). It lives in gitignored env as VITE_PRIVY_APP_ID / PRIVY_APP_ID.
- Login with X, email or wallet.
- Smart wallets are OFF. Embedded EVM wallets use `createOnLogin: 'users-without-wallets'`.
- Chain 4663 is the default and only chain.
- The backend verifies identity tokens via JWKS and prefers the embedded wallet.
- PRIVY_APP_SECRET is set by Marv; it is never in chat or code.

## Railway / config (names only, see .env.example)
DATABASE_URL, REDIS_URL, PRIVY_APP_ID, NAMES_CONTRACT_ADDRESS, NAMES_RENDERER_ADDRESS, WIFLY_CONTRACT_ADDRESS, BADGES_CONTRACT_ADDRESS, RPC_URL, AGENT_PRIVATE_KEY (Marv, in Railway), TX_ENABLED, AGENT_TX_ENABLED

- Each service has a Dockerfile and railway.json.
- gzip is on, `/healthz` is available, and Redis caches price, feed and rate limits.
- Price service: live WIF→USD over SSE.
- Database note: storage is libsql, opened via DATABASE_URL. It has not been ported to native Postgres drivers.
- The full deploy notes for peg are in **docs/DEPLOY-RAILWAY.md**: services, Postgres/Redis plugins, healthcheck /healthz, env var names, the post-deploy `setPot(Wifly)` step and the DB caveat.

## Checks
- Backend tests: 26/26 pass (incl. the name art theme test).
- Seed copy: the chain hashtag and every Robinhood mention in seed users/posts/trending were removed (replaced with #devtools / neutral copy). Only the "not affiliated with Robinhood" line remains of that kind. UI copy that names the chain itself ("Robinhood Chain") is unchanged. Frontend tsc and build are clean.
- `check:csp`: ok, and the secrets scan is clean.
- CSP plus `X-Frame-Options: DENY` are set on the frontend and backend, and Privy login works with the CSP applied.
- Load test (autocannon, 0 errors):

| Route | rps | p95 (ms) |
|---|---|---|
| /healthz | 8434 | 8.6 |
| /api/feed | 280 | 203 |
| /api/trending | 1306 | 43.4 |
| /api/price | 4183 | 16 |
| /api/names/market | 755 | 74.7 |
| /api/names/resolve | 1178 | 49.5 |
| /api/users | 1157 | 51.5 |

- Public preview: the cloudflared quick tunnel cannot connect from this box. Only port 443 egress is open, and 7844 (QUIC/http2 edge) is blocked.
  - Run `cloudflared tunnel --url http://localhost:4173` on a machine that allows outbound 7844, or use the Railway preview deploy.
