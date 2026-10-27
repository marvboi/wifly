// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Wifly} from "../src/Wifly.sol";
import {MockWIF} from "./mocks/MockWIF.sol";
import {Proxies} from "./utils/Proxies.sol";

contract Handler is Test {
    Wifly internal w;
    MockWIF internal token;
    address internal owner;
    uint256 internal attesterPk;
    address internal agent = makeAddr("inv-agent");

    address[] public actors;
    bytes32[] internal handles;
    uint256 public ghostEpochsVoted;
    uint256 public ghostEpochIn; // epochPot increases from any non-finalize action
    uint256 public ghostEpochPaid; // epochPot decreases from finalizeEpoch
    bool public ghostEpochPotDecreasedOutsideFinalize;
    bool public ghostTipNotDirect; // a tip credited the in-contract balance or paid the wrong net to the wallet

    modifier trackEpochPot(bool isFinalize) {
        uint256 before = w.epochPot();
        _;
        uint256 afterPot = w.epochPot();
        if (isFinalize) {
            ghostEpochPaid += before - afterPot;
        } else if (afterPot < before) {
            ghostEpochPotDecreasedOutsideFinalize = true;
        } else {
            ghostEpochIn += afterPot - before;
        }
    }

    constructor(Wifly w_, MockWIF token_, address owner_, uint256 attesterPk_) {
        w = w_;
        token = token_;
        owner = owner_;
        attesterPk = attesterPk_;
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            actors.push(a);
            token.mint(a, 1e30);
            vm.prank(a);
            token.approve(address(w), type(uint256).max);
            vm.prank(a);
            w.setAgent(agent, 1e24);
            vm.prank(a);
            w.setTier(uint8(i % 3), 10e18 * (i + 1));
            vm.prank(a);
            w.setContentPrice(bytes32(i), 5e18 * (i + 1));
        }
        handles.push(keccak256("x:1"));
        handles.push(keccak256("x:2"));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function _other(uint256 s) internal view returns (address) {
        return actors[(s % actors.length + 1) % actors.length];
    }

    function deposit(uint256 s, uint256 amt) external trackEpochPot(false) {
        amt = bound(amt, 1, 1e24);
        vm.prank(_actor(s));
        w.deposit(amt);
    }

    function withdraw(uint256 s, uint256 amt) external trackEpochPot(false) {
        address a = _actor(s);
        uint256 bal = w.balances(a);
        if (bal == 0) return;
        vm.prank(a);
        w.withdrawAmount(bound(amt, 1, bal));
    }

    /// @dev Tips go straight to the recipient's wallet: their WIF rises by exactly amt - fee and their
    ///      in-contract balance does not move.
    function _checkDirect(address to, uint256 balBefore, uint256 walletBefore, uint256 net) internal {
        if (w.balances(to) != balBefore || token.balanceOf(to) != walletBefore + net) ghostTipNotDirect = true;
    }

    function _net(uint256 amt) internal view returns (uint256) {
        return amt - (amt * w.feeBps()) / 10_000;
    }

    function tip(uint256 s, uint256 amt) external trackEpochPot(false) {
        amt = bound(amt, 1, 1e24);
        address to = _other(s);
        (uint256 b, uint256 t) = (w.balances(to), token.balanceOf(to));
        vm.prank(_actor(s));
        w.tip(to, amt, bytes32(s));
        _checkDirect(to, b, t, _net(amt));
    }

    function agentTip(uint256 s, uint256 amt) external trackEpochPot(false) {
        address a = _actor(s);
        uint256 bal = w.balances(a);
        uint256 rem = w.agentRemaining(a);
        uint256 max = bal < rem ? bal : rem;
        if (max == 0) return;
        amt = bound(amt, 1, max);
        address to = _other(s);
        (uint256 b, uint256 t) = (w.balances(to), token.balanceOf(to));
        vm.prank(agent);
        w.tipFor(a, to, amt, bytes32(s));
        _checkDirect(to, b, t, _net(amt));
    }

    function tipHandle(uint256 s, uint256 amt) external trackEpochPot(false) {
        amt = bound(amt, 1, 1e24);
        if (w.handleOwner(handles[s % handles.length]) == _actor(s)) return; // would be a self-tip
        address to = w.handleOwner(handles[s % handles.length]);
        (uint256 b, uint256 t) = to == address(0) ? (0, 0) : (w.balances(to), token.balanceOf(to));
        vm.prank(_actor(s));
        w.tipHandle(handles[s % handles.length], amt, bytes32(s));
        if (to != address(0)) _checkDirect(to, b, t, _net(amt));
    }

    function link(uint256 s) external trackEpochPot(false) {
        bytes32 h = handles[s % handles.length];
        address a = _actor(s);
        if (w.handleOwner(h) == a) return;
        uint256 deadline = block.timestamp + 1;
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(attesterPk, w.linkDigest(h, a, deadline));
        uint256 escrow = w.handleEscrow(h);
        (uint256 b, uint256 t) = (w.balances(a), token.balanceOf(a));
        vm.prank(a);
        w.linkHandle(h, deadline, abi.encodePacked(r, sg, v));
        _checkDirect(a, b, t, escrow); // released escrow lands in the wallet
        if (w.handleEscrow(h) != 0) ghostTipNotDirect = true;
    }

    function refund(uint256 id) external trackEpochPot(false) {
        uint256 next = w.nextHandleTipId();
        if (next == 1) return;
        id = bound(id, 1, next - 1);
        (address tipper, uint64 createdAt, bool settled, bytes32 h,) = w.handleTips(id);
        if (settled || w.handleOwner(h) != address(0) || block.timestamp < createdAt + 30 days) return;
        vm.prank(tipper);
        w.refundHandleTip(id);
    }

    function subscribe(uint256 s) external trackEpochPot(false) {
        address creator = _other(s);
        uint256 idx = (s % actors.length + 1) % actors.length;
        vm.prank(_actor(s));
        w.subscribe(creator, uint8(idx % 3));
    }

    function unlock(uint256 s) external trackEpochPot(false) {
        address creator = _other(s);
        bytes32 cid = bytes32((s % actors.length + 1) % actors.length);
        if (w.hasUnlocked(_actor(s), creator, cid)) return;
        vm.prank(_actor(s));
        w.unlock(creator, cid);
    }

    function pay(uint256 s, uint256 amt) external trackEpochPot(false) {
        amt = bound(amt, 1, 1e24);
        vm.prank(_actor(s));
        w.pay(_other(s), amt, bytes32(s));
    }

    function takeTopSpot(uint256 s, uint256 extra) external trackEpochPot(false) {
        if (block.timestamp < w.topSpotUnlocksAt()) vm.warp(w.topSpotUnlocksAt());
        uint256 amt = w.minTopSpotBid() + bound(extra, 0, 1e21);
        if (amt > 1e27) return;
        vm.prank(_actor(s));
        w.takeTopSpot(bytes32(s), amt);
    }

    function vote(uint256 s, uint256 amt) external trackEpochPot(false) {
        amt = bound(amt, 1, 1e24);
        vm.prank(_actor(s));
        w.vote(bytes32(s), _other(s), amt);
        ghostEpochsVoted++;
    }

    function finalize(uint256 back) external trackEpochPot(true) {
        uint256 cur = w.currentEpoch();
        uint256 ep = cur - 1 - bound(back, 0, 3);
        (address leader, bool fin,,,) = w.epochs(ep);
        if (leader == address(0) || fin) return;
        w.finalizeEpoch(ep, leader);
    }

    function claim(uint256 s, uint256 back) external trackEpochPot(false) {
        uint256 ep = w.currentEpoch() - bound(back, 1, 4);
        address a = _actor(s);
        (address leader, bool fin,,,) = w.epochs(ep);
        if (!fin || w.voterRewardClaimed(ep, a) || w.voterVotes(ep, a, leader) == 0) return;
        vm.prank(a);
        w.claimVoterReward(ep);
    }

    // ---------------------------------------------------------------- fee split / owner powers
    address public t1 = makeAddr("treasury-1");
    address public t2 = makeAddr("treasury-2");
    uint256 public ghostFunded; // WIF added with fundPot
    bool public ghostOwnerTookWif;

    function fundPot(uint256 s, uint256 amt) external trackEpochPot(false) {
        amt = bound(amt, 1, 1e24);
        vm.prank(_actor(s));
        w.fundPot(amt);
        ghostFunded += amt;
    }

    function setTreasury(uint256 s) external trackEpochPot(false) {
        vm.prank(owner);
        w.setTreasury(s % 2 == 0 ? t1 : t2);
    }

    /// @dev The owner tries to pull WIF out; with exact accounting there is never any excess to rescue.
    function ownerRescue(uint256 amt) external trackEpochPot(false) {
        vm.prank(owner);
        try w.rescue(address(token), owner, bound(amt, 1, 1e30)) {
            ghostOwnerTookWif = true;
        } catch {}
    }

    function pauseToggle() external trackEpochPot(false) {
        vm.startPrank(owner);
        w.pause();
        w.unpause();
        vm.stopPrank();
    }

    function setFee(uint256 bps) external trackEpochPot(false) {
        vm.prank(owner);
        w.setFeeBps(bound(bps, 0, 500));
    }

    // ---------------------------------------------------------------- auto-renew
    bool public ghostBadRenew; // a renewal succeeded when it must not, or charged != price, or above maxPrice
    bool public ghostMissedRenew; // a due, payable renewal reverted
    uint256 public ghostRenewals;

    function _tierIdx(address creator) internal view returns (uint8) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] == creator) return uint8(i % 3);
        }
        return 0;
    }

    function setAutoRenew(uint256 s, uint256 maxPrice) external trackEpochPot(false) {
        address creator = _other(s);
        vm.prank(_actor(s));
        w.setAutoRenew(creator, _tierIdx(creator), uint8(maxPrice % 2), bound(maxPrice, 0, 1_000e18));
    }

    function setTierPrice(uint256 s, uint256 price) external trackEpochPot(false) {
        address creator = _actor(s);
        vm.prank(creator);
        w.setTier(_tierIdx(creator), bound(price, 1, 100e18));
    }

    function setYearlyPrice(uint256 s, uint256 price) external trackEpochPot(false) {
        address creator = _actor(s);
        vm.prank(creator);
        w.setYearlyPrice(_tierIdx(creator), bound(price, 0, 1_000e18)); // 0 disables yearly
    }

    function subscribeYearly(uint256 s) external trackEpochPot(false) {
        address creator = _other(s);
        uint8 tier = _tierIdx(creator);
        if (w.yearlyPrices(creator)[tier] == 0) return;
        vm.prank(_actor(s));
        w.subscribePlan(creator, tier, 1);
    }

    struct RenewCtx {
        address user;
        address creator;
        uint8 plan;
        uint240 maxPrice;
        uint64 expiry;
        uint256 price;
        uint256 bal;
        uint256 wallet;
    }

    function renew(uint256 s) external trackEpochPot(false) {
        RenewCtx memory c;
        c.user = _actor(s);
        c.creator = _other(s);
        uint8 tier;
        (tier, c.plan, c.maxPrice) = w.autoRenewOf(c.user, c.creator);
        (,, c.expiry) = w.isSubscribed(c.user, c.creator);
        c.price = c.plan == 1 ? w.yearlyPrices(c.creator)[tier] : w.tierPrices(c.creator)[tier];
        c.bal = w.balances(c.user);
        c.wallet = token.balanceOf(c.user);
        bool expected = c.maxPrice != 0 && c.expiry != 0 && block.timestamp >= c.expiry && c.price != 0
            && c.price <= c.maxPrice && (c.bal >= c.price || c.wallet >= c.price);
        try w.renew(c.user, c.creator) {
            if (!expected || !_renewOk(c)) ghostBadRenew = true;
            ghostRenewals++;
        } catch {
            if (expected) ghostMissedRenew = true;
        }
    }

    function _renewOk(RenewCtx memory c) internal view returns (bool) {
        uint256 newBal = w.balances(c.user);
        uint256 charged = (c.bal + c.wallet) - (newBal + token.balanceOf(c.user));
        if (charged != c.price || c.price > c.maxPrice) return false;
        // deposit first only if it covers the full price, otherwise the wallet
        if (c.bal >= c.price ? newBal != c.bal - c.price : newBal != c.bal) return false;
        // exactly one period of the opted-in plan: from the old expiry in grace, from now after it
        (,, uint64 newExpiry) = w.isSubscribed(c.user, c.creator);
        uint256 start = c.expiry + w.gracePeriod() > block.timestamp ? c.expiry : block.timestamp;
        return newExpiry == start + (c.plan == 1 ? 365 days : 30 days) && newExpiry > block.timestamp;
    }

    function warp(uint256 secs) external trackEpochPot(false) {
        vm.warp(block.timestamp + bound(secs, 1, 10 days));
    }
}

contract WiflyInvariantTest is Test {
    Wifly internal w;
    MockWIF internal token;
    Handler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        uint256 pk = 0xA11CE;
        token = new MockWIF();
        address owner = makeAddr("owner");
        w = Proxies.wifly(address(token), true, owner, vm.addr(pk), makeAddr("treasury-1"), 100e18);
        handler = new Handler(w, token, owner, pk);
        targetContract(address(handler));
    }

    /// @dev Core solvency property: the contract always holds enough WIF for every liability.
    function invariant_solvent() public view {
        assertGe(token.balanceOf(address(w)), w.totalLiabilities());
    }

    /// @dev Without stray transfers, holdings equal liabilities exactly (no value created or lost).
    function invariant_exactAccounting() public view {
        assertEq(token.balanceOf(address(w)), w.totalLiabilities());
    }

    /// @dev The owner can't drain the community pot: epoch rewards paid out + epochPot left always equals
    ///      all pot inflow, nothing but finalizeEpoch lowers it, and the owner never receives any WIF.
    function invariant_epochPotNotDrainable() public view {
        assertFalse(handler.ghostEpochPotDecreasedOutsideFinalize());
        assertEq(w.epochPot() + handler.ghostEpochPaid(), handler.ghostEpochIn());
        assertFalse(handler.ghostOwnerTookWif());
        assertEq(token.balanceOf(w.owner()), 0);
    }

    /// @dev 90/10: every split burns floor(10%) and puts the rest in the pot; the treasury never gets Wifly fees.
    function invariant_feeSplitRatios() public view {
        uint256 burned = w.totalBurned();
        uint256 toTreasury = token.balanceOf(handler.t1()) + token.balanceOf(handler.t2());
        uint256 toPot = handler.ghostEpochIn() - handler.ghostFunded();
        assertEq(toTreasury, 0);
        assertGe(toPot, 9 * burned);
        assertLe(10 * burned, toPot + burned);
    }

    /// @dev Every tip (tip, tipFor, tipHandle to a linked handle, escrow released on link) pays the recipient's
    ///      wallet directly and never credits their in-contract balance.
    function invariant_tipsPaidToWallet() public view {
        assertFalse(handler.ghostTipNotDirect());
    }

    /// @dev totalBalances equals the sum of all individual balances.
    function invariant_balancesSum() public view {
        uint256 sum;
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            sum += w.balances(handler.actors(i));
        }
        assertEq(sum, w.totalBalances());
    }

    /// @dev Auto-renew only charges when due and opted in, exactly the current price, never above maxPrice,
    ///      and once per period (a success always pushes expiry past now, so a second call can't be due).
    function invariant_renewNeverOverOrDoubleCharges() public view {
        assertFalse(handler.ghostBadRenew());
        assertFalse(handler.ghostMissedRenew());
    }

    /// @dev Burns only reduce supply; the tracked burn total matches the supply drop.
    function invariant_burnTracked() public view {
        assertEq(token.totalSupply() + w.totalBurned(), 4 * 1e30);
    }
}
