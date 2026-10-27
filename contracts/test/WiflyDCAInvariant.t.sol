// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WiflyDCA} from "../src/WiflyDCA.sol";
import {MockWIF} from "./mocks/MockWIF.sol";
import {MockUniversalRouter, MockV4Quoter} from "./mocks/MockV4Swap.sol";
import {Proxies} from "./utils/Proxies.sol";

contract DCAHandler is Test {
    WiflyDCA internal dca;
    MockUniversalRouter internal router;
    address internal owner;
    address internal keeper;
    address[] internal actors;

    uint256 public ghostIn; // ETH deposited
    uint256 public ghostOut; // ETH withdrawn by plan owners
    uint256 public ghostSwapped; // ETH sent to the router
    uint256 public ghostTips;
    uint256 public ghostWifToOwners;
    uint256 public ghostBuys;
    bool public ghostWithdrawWhilePausedFailed;

    constructor(WiflyDCA d, MockUniversalRouter r, address owner_, address keeper_) {
        dca = d;
        router = r;
        owner = owner_;
        keeper = keeper_;
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string(abi.encodePacked("dca-actor", vm.toString(i))));
            actors.push(a);
            vm.deal(a, 1_000 ether);
        }
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function _plan(uint256 s) internal view returns (uint256 id, address who) {
        uint256 n = dca.nextPlanId() - 1;
        if (n == 0) return (0, address(0));
        id = s % n + 1;
        who = dca.getPlan(id).owner;
    }

    function create(uint256 s, uint256 dep, uint256 amt, uint256 interval, uint256 tip, uint256 maxBuys) external {
        if (dca.paused()) return;
        address a = _actor(s);
        dep = bound(dep, 0, 5 ether);
        amt = bound(amt, 1e12, 1 ether);
        interval = bound(interval, 1 hours, 30 days);
        tip = bound(tip, 0, amt / 100);
        maxBuys = bound(maxBuys, 0, 20);
        WiflyDCA.PlanParams memory p = WiflyDCA.PlanParams({
            amountPerBuy: uint128(amt),
            interval: uint32(interval),
            maxBuys: uint32(maxBuys),
            minWifPerEth: s % 2 == 0 ? 1_000_000e18 : 0,
            maxSlippageBps: 100,
            keeperTip: uint128(tip)
        });
        vm.prank(a);
        dca.createPlan{value: dep}(p, 0);
        ghostIn += dep;
    }

    function topUp(uint256 s, uint256 amt) external {
        (uint256 id, address who) = _plan(s);
        if (who == address(0) || dca.getPlan(id).cancelled) return;
        amt = bound(amt, 1, 2 ether);
        vm.prank(who);
        dca.topUp{value: amt}(id);
        ghostIn += amt;
    }

    function withdraw(uint256 s, uint256 amt) external {
        (uint256 id, address who) = _plan(s);
        if (who == address(0)) return;
        uint256 bal = dca.getPlan(id).balance;
        if (bal == 0) return;
        amt = bound(amt, 1, bal);
        vm.prank(who);
        try dca.withdraw(id, amt) {
            ghostOut += amt;
        } catch {
            if (dca.paused()) ghostWithdrawWhilePausedFailed = true;
            revert("withdraw failed");
        }
    }

    function cancel(uint256 s) external {
        (uint256 id, address who) = _plan(s);
        if (who == address(0) || dca.getPlan(id).cancelled) return;
        uint256 bal = dca.getPlan(id).balance;
        vm.prank(who);
        dca.cancelPlan(id);
        ghostOut += bal;
    }

    function togglePlanPause(uint256 s) external {
        (uint256 id, address who) = _plan(s);
        if (who == address(0) || dca.getPlan(id).cancelled) return;
        bool p = dca.getPlan(id).paused;
        vm.prank(who);
        dca.setPlanPaused(id, !p);
    }

    function toggleContractPause() external {
        bool p = dca.paused();
        vm.prank(owner);
        if (p) dca.unpause();
        else dca.pause();
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 3 days));
    }

    function setRate(uint256 r) external {
        router.setRate(bound(r, 100_000e18, 5_000_000e18));
    }

    function _minFor(uint256 id, uint256 s) internal view returns (uint256) {
        uint256 q = router.out(dca.getPlan(id).amountPerBuy);
        // mostly good mins, sometimes lax / impossible ones
        if (s % 5 == 0) return q / 2;
        if (s % 7 == 0) return q + 1;
        return q * 995 / 1000;
    }

    function execute(uint256 s) external {
        if (dca.paused()) return;
        (uint256 id, address who) = _plan(s);
        if (who == address(0)) return;
        uint256 min = _minFor(id, s);
        WiflyDCA.Plan memory before = dca.getPlan(id);
        uint256 wifBefore = router.wif().balanceOf(who);
        vm.prank(keeper);
        try dca.execute(id, min) returns (uint256 out) {
            ghostSwapped += before.amountPerBuy;
            ghostTips += before.keeperTip;
            ghostWifToOwners += out;
            ghostBuys++;
            assertEq(router.wif().balanceOf(who) - wifBefore, out);
            assertGe(out, min);
        } catch {
            assertEq(dca.getPlan(id).balance, before.balance, "failed buy moved ETH");
        }
    }

    function executeBatch(uint256 s, uint256 n) external {
        if (dca.paused()) return;
        uint256 total = dca.nextPlanId() - 1;
        if (total == 0) return;
        n = bound(n, 1, 6);
        s = bound(s, 0, 1e30);
        uint256[] memory ids = new uint256[](n);
        uint256[] memory mins = new uint256[](n);
        uint256 balBefore;
        uint256 tipsBefore = keeper.balance;
        for (uint256 i; i < n; ++i) {
            ids[i] = (s + i * 7) % (total + 1); // includes id 0 (no plan) sometimes
            mins[i] = ids[i] == 0 ? 1 : _minFor(ids[i], s + i);
        }
        balBefore = address(router).balance;
        vm.prank(keeper);
        ghostBuys += dca.executeBatch(ids, mins); // must never revert
        ghostSwapped += address(router).balance - balBefore;
        ghostTips += keeper.balance - tipsBefore;
    }
}

contract WiflyDCAInvariantTest is Test {
    WiflyDCA dca;
    MockWIF wif;
    MockUniversalRouter router;
    DCAHandler h;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");

    function setUp() public {
        vm.warp(1_800_000_000);
        wif = new MockWIF();
        address hooks = makeAddr("hooks");
        router = new MockUniversalRouter(wif, hooks, 1_886_000e18);
        MockV4Quoter quoter = new MockV4Quoter(router);
        dca = Proxies.dca(owner, address(router), address(quoter), address(wif), hooks, 0, 200);
        vm.prank(owner);
        dca.setKeeper(keeper, true);
        h = new DCAHandler(dca, router, owner, keeper);
        targetContract(address(h));
    }

    function _sumBalances() internal view returns (uint256 sum) {
        uint256 n = dca.nextPlanId();
        for (uint256 i = 1; i < n; ++i) {
            sum += dca.getPlan(i).balance;
        }
    }

    function invariant_ethHeldEqualsSumOfDeposits() public view {
        assertEq(address(dca).balance, dca.totalDeposits(), "balance != totalDeposits");
        assertEq(dca.totalDeposits(), _sumBalances(), "totalDeposits != sum(plan.balance)");
    }

    function invariant_neverHoldsWif() public view {
        assertEq(wif.balanceOf(address(dca)), 0);
    }

    function invariant_ethConserved() public view {
        // every wei in is either still in a plan, back with its owner, swapped, or tipped
        assertEq(h.ghostIn(), dca.totalDeposits() + h.ghostOut() + h.ghostSwapped() + h.ghostTips());
        assertEq(address(router).balance, h.ghostSwapped());
    }

    function invariant_cancelledPlansAreEmpty() public view {
        uint256 n = dca.nextPlanId();
        for (uint256 i = 1; i < n; ++i) {
            WiflyDCA.Plan memory p = dca.getPlan(i);
            if (p.cancelled) assertEq(p.balance, 0);
            if (p.maxBuys != 0) assertLe(p.buysDone, p.maxBuys);
        }
    }

    function invariant_withdrawalsNeverBlockedByPause() public view {
        assertFalse(h.ghostWithdrawWhilePausedFailed());
    }
}
