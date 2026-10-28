# Wifly contracts

Wifly is a social app where everything runs on $WIF (World Is Flat) on Robinhood Chain (chain id 4663).
`src/Wifly.sol` is one small contract that handles tips, X-handle escrow, creator subscriptions,
paid unlocks, generic payments, the Top Spot game, pay-to-vote weekly crowd picks and capped AI-agent spending.
`src/WiflyNames.sol` is the username registry and marketplace (ERC-721) and `src/WiflyBadges.sol` gives soulbound
burn badges (ERC-1155). `src/WiflyDCA.sol` dollar-cost-averages ETH into WIF through the live Uniswap v4 pool
(see DCA). Plain swaps are not a contract: the app links to existing WIF liquidity (see Swap).

- $WIF: `0x5173b8eA6923c2d40267890D45C46a3480954773` (18 decimals, ownerless, OpenZeppelin-style `burn(uint256)`;
  the selector is in the deployed bytecode and the fork test confirms it lowers `totalSupply`).
- Solidity 0.8.28, OpenZeppelin 5.1 (SafeERC20, ReentrancyGuard, Ownable2Step, Pausable, EIP712/ECDSA).

## Money rules
| Action | Split |
|---|---|
| **fee split** (`_splitFee`) | every fee/charge below: **90% to the community pot** (`epochPot`), **10% burned** (`POT_BPS` 9000 / `BURN_BPS` 1000, constants). Burn rounds down; dust goes to the pot. The treasury gets 0% of Wifly fees. Emits `FeeSplit(potAmount, burnAmount)` |
| tip / subscribe / unlock / pay | platform fee `feeBps` (default 2%, max 5%) goes through the fee split; the rest goes to the recipient's balance. `quoteFee(amount)` returns `(fee, potPart, burnPart, net)` |
| Top Spot | bid >= max(floor, 110% of current). 90% to the previous holder, the other 10% through the fee split. If the spot was empty the whole bid goes through the fee split. Minimum hold 60s (owner can set 0 to 1 day) |
| vote | the whole amount goes through the fee split (10% burned, 90% to the pot that week's winner/voters share). Weekly epochs (`block.timestamp / 7 days`) |
| `fundPot(amount)` | anyone can add WIF straight to `epochPot` (WiflyNames uses it for its pot share). Works while paused |
| finalizeEpoch | splits `payablePot()` (epochPot minus WIF that arrived during the current week): winner gets `winnerShareBps` (50%); `voterShareBps` (50%) is reserved for that winner's voters, pro rata. Leftover/empty weeks roll over |

Tips (`tip`, `tipFor`, `tipHandle` to a linked handle, and escrow released by `linkHandle`) are sent straight to the recipient's wallet, net of the 2% fee. Every other payout (subscriptions, unlocks, pay, Top Spot, pot rewards, handle-tip refunds) is credited to `balances` (pull payments) and claimed with `withdraw()`. Pausing blocks new payments
and deposits; withdrawals, refunds, linking, finalize and claims keep working.
**Owner can't drain the community pot:** there is no owner pot and no owner payout function. Only `finalizeEpoch` can spend `epochPot`, and once a week is finalized its voter share is locked in `totalVoterPools`. `rescue` is capped at excess WIF (above all liabilities). `communityPot()` is a view of `epochPot`. Invariant tests check that nothing except `finalizeEpoch` ever lowers `epochPot`, that the owner never receives WIF, and the 90/10 ratios.

Solvency invariant: `WIF.balanceOf(wifly) >= totalBalances + totalEscrow + epochPot + totalVoterPools`.

## Subscriptions, plans and auto-renew
- Each creator has up to 3 tiers. Every tier has two **explicit** prices set by the creator: `setTier(tier, monthly)` and
  `setYearlyPrice(tier, yearly)` (no discount math; 0 disables that plan). Prices can change at any time.
- Plans: `MONTHLY = 0` (30 days) and `YEARLY = 1` (365 days). `subscribePlan(creator, tier, plan)` pays from the wallet,
  `subscribeForPlan(user, creator, tier, plan)` from the deposit (user or their agent). `subscribe` / `subscribeFor` are monthly shortcuts.
- Same tier while active or in grace extends from the old expiry (no gap, no free days). A different tier or a lapsed
  sub starts fresh from now (unused time is forfeited, so a cheap tier can't be upgraded cheaply).
- **Grace:** `gracePeriod` (default 5 days, owner can set 1 to 30 days). `subStatus` returns `active`, `hasAccess` (active or in grace), tier, expiry, `graceEndsAt` and plan.
- **Auto-renew (opt-in):** `setAutoRenew(creator, tier, plan, maxPrice)` stores the tier, plan and the most one renewal
  may cost (the price shown at opt-in). `maxPrice = 0` opts out and stops every future renewal immediately.
  `renew(user, creator)` can be called by anyone (keeper/agent), only after expiry, only if opted in:
  - charges the creator's **current** price for that plan, never above `maxPrice` (a raise above it makes renewal revert `PriceAboveMax`; a cut charges less);
  - pays from the deposit if it covers the full price, otherwise `transferFrom` the wallet allowance; if neither covers it, the tx reverts and nothing is emitted;
  - within grace: new expiry = old expiry + plan period; after grace: a fresh period from now;
  - once per period: after a renewal the sub is active again, so another call reverts `NotRenewable` until the next expiry.
- The frontend should approve a **capped** allowance (3, 6 or 12 months of the price, or 1-2 years for yearly), never unlimited.
- **Wifly Plus** is just a creator account run by the team wallet: it calls `setTier(0, 1_500e18)` and `setYearlyPrice(0, 15_000e18)`
  (defaults: **1,500 WIF/month, 15,000 WIF/year**). The deploy script does not set these; the team wallet sends the two txs.

## .wif names (`WiflyNames`, ERC-721 "WIF Names" / WIFNAME)
A mini ENS for the WIF ecosystem on Robinhood Chain. Each token is a name shown as `<label>.wif` (token metadata
name "marv.wif"); the contract stores the bare label. See `docs/WIF-NAMES.md` for the integration note.
- Labels: 3-20 bytes of `[a-z0-9_]`. `tokenId = uint256(keccak256(bytes(label)))`; one owner per name, no expiry.
  Every name-taking function accepts `marv` or `marv.wif` (`toLabel` strips one exact lowercase ".wif"); `isValidName` checks a bare label.
- `claim(name)` charges the claim fee and splits it 50% `treasury` / 50% Wifly community pot (no burn): `claimFee` (default 100 WIF), `shortClaimFee` for 3-4 char names (default 1,000 WIF). `quoteClaimSplit(fee)` returns `(treasuryPart, potPart)`.
  The first name you get becomes your primary (`primaryOf` / `nameOf(address)`), changeable with `setPrimary`.
- Resolver (owner-only, wiped on every transfer incl. sales via `recordVersion`): `setAddr(id, a)` / `addr(name)` / `resolve("marv.wif")`
  (defaults to the owner), `setText(id, key, value)` / `text(name, key)` (key 1-64 B, value <= 256 B, "" deletes).
  Reverse: `reverseName(address)` = "marv.wif" only if that address's primary forward-resolves back to it.
  `multicall(bytes[])` batches claim + records in one tx.
- `reserve(name, to)`: owner-only, free, until `lockReservations()` (one-way).
- Marketplace in WIF: `list(id, price)`, `cancel(id)`, `buy(id, maxPrice)`. Fee `feeBps` (default 2.5%, max 10%), split 90% pot / 10% burned; `quoteSale(price)` returns `(fee, potPart, burnPart, net)`.
  The pot share goes to Wifly via `approve` + `fundPot` on the owner-set `pot` (`setPot`, the deploy script wires it). If `pot` is unset (0) it goes to `treasury`.
  **Any transfer clears the listing** (in `_update`), so a stale listing can never be bought. Transfers also clear the sender's primary.
- `tokenURI` is on-chain JSON. Owner can set fees, treasury, pot, pause.

## Burn badges (`WiflyBadges`, ERC-1155, soulbound)
- `burn(amount)` burns your WIF (approve first) and mints every badge whose threshold your **cumulative** burn has reached.
  Badge id `i` = level `i`; defaults 1k / 10k / 100k / 1M WIF. Owner can only `addLevel` (strictly increasing, max 32);
  existing holders call `claim(user)` (anyone can) to receive newly added levels.
- Soulbound: transfers and `setApprovalForAll` revert. Minting skips the receiver hook so smart-account wallets can earn.
- Only direct burns through this contract count (not Wifly votes/fees).

## DCA (`WiflyDCA`, ETH -> WIF)
Recurring buys of $WIF with ETH through the Uniswap v4 WIF/ETH pool (Universal Router `V4_SWAP`, pool key
`{0x0, WIF, fee 0, tickSpacing 200, hooks 0xe5e7…e044}`; the PonsV2 hook takes 1% of the output, already in quotes).
**No platform fee.** The only optional cost is a keeper tip the user sets per buy (default 0).
- `createPlan({amountPerBuy, interval, maxBuys, minWifPerEth, maxSlippageBps, keeperTip}, startAt)` with ETH attached.
  `interval` >= 1 hour; `maxBuys` 0 = until the deposit runs out; `minWifPerEth` = price floor (WIF wei per 1 ETH, 0 = none);
  `maxSlippageBps` <= 1000. At least one of floor / slippage cap must be set (both apply if both are set).
- Users can `topUp`, `updatePlan`, `setPlanPaused`, `withdraw`, `withdrawAll`, `cancelPlan` (refunds the rest) at any time.
- `execute(planId, minWifOut)` / `executeBatch(ids, mins)` are keeper-only (`setKeeper`, owner-managed). Each buy swaps exactly
  `amountPerBuy`, at most once per `interval` (a late keeper doesn't catch up), and sends WIF **straight to the plan owner**:
  the contract never holds WIF. Checks: `minWifOut >= amountPerBuy * minWifPerEth / 1e18`, and if a slippage cap is set,
  `minWifOut >= onchainQuote * (1e4 - bps) / 1e4` using the V4Quoter on-chain (a keeper can't pass a lax min); the
  router enforces `minWifOut` and the contract re-checks the owner's WIF balance delta. `executeBatch` skips (event
  `Skipped(planId, reason)`) instead of reverting; a failed swap is rolled back.
- Keeper flow: `status(id)` (0 = ready), get a quote off-chain (`quoteExactInputSingle`, `poolKey()`, `amountPerBuy`),
  pass `min = max(quote * (1e4 - bps) / 1e4, floorWifOut(id))`. The keeper pays gas (~290-320k per buy on the fork).
- ETH held always equals `totalDeposits` (sum of plan balances); no `receive()`. Contract `pause()` blocks only new plans
  and buys; withdraw/cancel/top-up/edit always work.

## Swap
No swap contract. WIF trades on **Uniswap v4** on Robinhood Chain: WIF/native ETH pool id
`0x71ef4106340f0a3b9c19ec994eef4fc44a1d2513f38faac39d7636b156548c79` (~$99k liquidity, ~$83k 24h volume on 25 Oct 2026).
Uniswap on 4663 (from developers.uniswap.org; code checked on chain): Universal Router `0x8876789976decbfcbbbe364623c63652db8c0904`
(v2.1.2: `0x204FAca1764B154221e35c0d20aBb3c525710498`), PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`,
Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`. Smaller pools: v3 WIF/WETH and WIF/USDG.
In the app, embed the LI.FI widget or deep-link KyberSwap (`https://kyberswap.com/swap/robinhood/eth-to-wif`); both route through these pools.
The token launched on Pons: https://ponsfamily.com/launchpad/0x5173b8eA6923c2d40267890D45C46a3480954773

## X linking (attester)
1. The backend runs X OAuth and learns the user's stable X user id.
2. `handleHash = keccak256(abi.encodePacked("x:", xUserId))`. Use the numeric id, not the @handle, because handles can be renamed.
3. The backend signs EIP-712 `LinkHandle(bytes32 handleHash,address account,uint256 nonce,uint256 deadline)`,
   domain `{name: "Wifly", version: "1", chainId, verifyingContract}`, with `nonce = handleNonce(handleHash)`.
4. The user calls `linkHandle(handleHash, deadline, sig)`. Escrowed tips move into their balance.
   Re-linking to a new wallet needs a new signature (the nonce bumps). Unclaimed escrow tips can be refunded to the tipper after 30 days (net of the fee).

## Agents
`setAgent(agent, dailyCap)` lets one agent spend from the user's **deposited** balance through
`tipFor`, `subscribeFor` and `takeTopSpotFor`, up to `dailyCap` per UTC day. An agent can't withdraw. `revokeAgent()` or
`setAgent(0, 0)` turns it off. The user can call the same `*For` functions on themselves for one-tap spending from their balance (no cap).

## Commands
```sh
forge build
forge test                                                       # unit + fuzz + invariant
RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract Fork   # real WIF fork test

# deploy (not done yet). Chain 4663 only. The key lives in an encrypted keystore or a Ledger, never in env or code
cast wallet import wifly-deployer --interactive
cp .env.example .env   # fill WIFLY_ATTESTER (+ optional WIFLY_OWNER [defaults to WIFLY_TREASURY], WIFLY_KEEPER, names/badges/DCA config)
source .env && forge script script/DeployWifly.s.sol --rpc-url $RH_RPC_URL --account wifly-deployer --broadcast
# or: --ledger --sender <ledger address>
# the script prints each PROXY (use this address everywhere) and its IMPL
forge verify-contract <impl> src/Wifly.sol:Wifly --chain-id 4663 --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/   # same for WiflyNames / WiflyBadges / WiflyDCA / WiflyGlyphs
# proxies: verify ERC1967Proxy (lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol) with
# --constructor-args $(cast abi-encode "f(address,bytes)" <impl> <initialize calldata>); Blockscout then links proxy -> impl
```

## Upgradeability (UUPS)
- `Wifly`, `WiflyNames`, `WiflyBadges`, `WiflyDCA` and `WiflyGlyphs` are UUPS (ERC-1822/ERC-1967) proxies built on
  OpenZeppelin Contracts Upgradeable 5.1 (`Initializable`, `UUPSUpgradeable`, `Ownable2StepUpgradeable`,
  `ReentrancyGuardUpgradeable`, `PausableUpgradeable`, `ERC721Upgradeable` / `ERC1155Upgradeable`, `EIP712Upgradeable`).
  `WiflyNameRenderer` stays a plain contract that the owner swaps with `setRenderer` (until `lockRenderer`).
- Implementations call `_disableInitializers()` in their constructor, so nobody can initialize or take over the logic
  contract. `initialize(...)` replaces the old constructor (same arguments and checks) and can run once.
- Former immutables (`wif`, `useBurnFunction`, DCA `router`/`quoter`/`hooks`/`poolFee`/`tickSpacing`) are now storage set
  in `initialize`; defaults (fees, grace period, shares, ids) are set there too. Getters are unchanged.
- Upgrades: the owner calls `upgradeToAndCall(newImpl, data)` on the proxy (`_authorizeUpgrade` is `onlyOwner`).
  The new implementation must be UUPS (has `proxiableUUID`) or the call reverts.
- Storage layout: OZ parents use ERC-7201 namespaced slots. Each Wifly contract's own variables start at slot 0 and end
  with `uint256[50] private __gap`. In a V2, never reorder, retype or delete variables; only append new ones before the
  gap and shrink the gap by the same number of slots. Check with `forge inspect <Contract> storageLayout` before and
  after. Use `reinitializer(n)` for any V2 setup.
- `test/WiflyUpgrade.t.sol` covers: initialize can't run twice, implementations can't be initialized or upgraded
  directly, only the owner (not a pending owner) can upgrade, non-UUPS targets are rejected, and V2 upgrades keep all
  state (balances, pot, EIP-712 domain, names/themes/records, badges, DCA plans and keepers, glyph output).

## Files
- `src/Wifly.sol`: tips, subs (monthly/yearly, grace, auto-renew), unlocks, Top Spot, votes, agents
- `src/WiflyNames.sol`: usernames + marketplace
- `src/WiflyBadges.sol`: soulbound burn badges
- `src/WiflyDCA.sol`: ETH -> WIF DCA plans (keeper-run, no fee)
- `src/interfaces/IBurnableERC20.sol`, `src/interfaces/IUniswapV4Minimal.sol`
- `test/Wifly.t.sol`: unit and fuzz tests
- `test/WiflyRenew.t.sol`: plans, grace, auto-renew (deposit/allowance, no double/over-charge, opt-out, price changes)
- `test/WiflyNames.t.sol`, `test/WiflyBadges.t.sol`: unit and fuzz tests
- `test/WiflyInvariant.t.sol`: handler-based invariants (solvency, exact accounting, balance sums, burn tracking, epoch pot can't be drained, 90/10 ratios, renew never over/double-charges)
- `test/WiflyNamesResolver.t.sol`: .wif suffix handling, addr/text/reverse records, clearing on transfer and sale
- `test/WiflyExtrasInvariant.t.sol`: names unique, no listing survives a transfer, primary always owned, reverse lookup consistent, records never survive a transfer, badges soulbound and exact, names fee split into the Wifly pot
- `test/WiflyFork.t.sol`: real $WIF on chain 4663 (skipped without `RH_RPC_URL`)
- `test/WiflyDCA.t.sol`: DCA unit + fuzz (interval, floor, slippage vs on-chain quote, tips, pause, batch skips, reentrancy)
- `test/WiflyDCAInvariant.t.sol`: ETH held == deposits, never holds WIF, ETH conserved, cancelled plans empty, withdrawals work while paused
- `test/WiflyDCAFork.t.sol`: real buys through the live v4 pool (skipped without `RH_RPC_URL`)
- `test/WiflyUpgrade.t.sol`: UUPS proxy safety + state-preserving V2 upgrades (`test/mocks/MockV2.sol`)
- `test/mocks/MockWIF.sol`, `test/mocks/MockV4Swap.sol`, `test/utils/WiflyBase.sol`, `test/utils/Proxies.sol` (impl + ERC1967Proxy + initialize helpers)
- `script/DeployWifly.s.sol`: deploys each implementation + `ERC1967Proxy` (initialize calldata), prints proxy and impl addresses

## Trust assumptions
Upgrades: the owner of each proxy can replace its code (`upgradeToAndCall`), so that key can change any rule,
including user balances. Keep it on a multisig or hardware wallet; consider a timelock before launch.
The owner can change the fee (max 5%), the attester, the `treasury` (non-zero, `setTreasury`), the Top Spot floor and hold, and the epoch shares; pause new payments;
and rescue only *excess* WIF. The owner can't spend `epochPot`. The owner can't touch user balances or escrow.
The attester can bind any X id to any wallet, so keep its key in a KMS.
WiflyNames owner: claim fees, marketplace fee (max 10%), treasury, pot, reserve names until locked, pause. It can't take or move anyone's name.
WiflyBadges owner: add levels (append-only), set URI, pause. It can't mint arbitrary badges or move them.
Auto-renew: a keeper can only trigger a renewal the user opted into, after expiry, at most `maxPrice`, once per period.
Creators can change prices anytime; that can only stop renewals, never raise what's charged above `maxPrice`.
WiflyDCA owner: add/remove keepers, pause new plans and buys, sweep only ETH above `totalDeposits`, rescue stray tokens.
It can't touch plan balances, and pausing never blocks withdrawals. A keeper can only buy for a plan that is due,
exactly `amountPerBuy`, within the user's floor/slippage limits, paid to the plan owner; the worst a keeper can do is not run
(or pick the worst price inside the user's limits). Trusted code: Uniswap's Universal Router, V4Quoter and the pool's PonsV2 hook.

## Username art (fully on-chain)
- `tokenURI` on WiflyNames calls `renderer.tokenURI(id, name, rare, reserved)` (`IWiflyNameRenderer`), which returns
  `data:application/json;base64,…` with name, description, attributes (Length, Characters = Letters/Numbers/Mixed,
  Rarity = Rare for 3-4 chars, Short name, Reserved) and an animated `data:image/svg+xml;base64,…` image. No URLs.
- `WiflyGlyphs` stores the WIF Par font (the World is Flat brand font the app uses) as SVG outlines with its kerning,
  generated by `brand/name-nft/_src/gen_glyphs.py`. Text is drawn as `<use>` glyphs, so no web font is needed.
- `WiflyNameRenderer` builds the art (restyle in its ART section, redeploy, then owner `setRenderer(new)`).
  `setRenderer` emits ERC-4906 `BatchMetadataUpdate` so marketplaces refresh; `lockRenderer()` freezes the art forever.
  `setRenderer(address(0))` falls back to plain JSON. `isReserved(id)` marks names minted with `reserve()`.
- Previews: `forge script script/RenderNamePreviews.s.sol` (local, no broadcast) writes SVG + tokenURI to
  `brand/name-nft/`; `python3 brand/name-nft/_src/check.py` validates them; `_src/render.py` makes PNG/GIF/MP4.
