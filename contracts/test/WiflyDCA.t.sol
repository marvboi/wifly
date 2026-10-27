// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {WiflyDCA} from "../src/WiflyDCA.sol";
import {MockWIF} from "./mocks/MockWIF.sol";
import {MockUniversalRouter, MockV4Quoter} from "./mocks/MockV4Swap.sol";
import {Proxies} from "./utils/Proxies.sol";

abstract contract DCABase is Test {
    WiflyDCA internal dca;
    MockWIF internal wif;
    MockUniversalRouter internal router;
    MockV4Quoter internal quoter;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal hooks = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    uint256 internal constant START = 1_800_000_000;
    uint256 internal constant RATE = 1_886_000e18; // WIF per ETH before the 1% hook cut (~1,867k after)

    function setUp() public virtual {
        vm.warp(START);
        wif = new MockWIF();
        router = new MockUniversalRouter(wif, hooks, RATE);
        quoter = new MockV4Quoter(router);
        dca = Proxies.dca(owner, address(router), address(quoter), address(wif), hooks, 0, 200);
        vm.prank(owner);
        dca.setKeeper(keeper, true);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _params(uint128 amt, uint32 interval, uint32 maxBuys, uint256 floor, uint16 slip, uint128 tip)
        internal
        pure
        returns (WiflyDCA.PlanParams memory p)
    {
        p = WiflyDCA.PlanParams({
            amountPerBuy: amt,
            interval: interval,
            maxBuys: maxBuys,
            minWifPerEth: floor,
            maxSlippageBps: slip,
            keeperTip: tip
        });
    }

    /// 0.01 ETH every hour, floor 1,000,000 WIF/ETH, 1% slippage cap
    function _create(address who, uint256 deposit) internal returns (uint256 id) {
        vm.prank(who);
        id = dca.createPlan{value: deposit}(_params(0.01 ether, 1 hours, 0, 1_000_000e18, 100, 0), 0);
    }

    function _quote(uint256 id) internal view returns (uint256) {
        return router.out(dca.getPlan(id).amountPerBuy);
    }

    function _assertBooks() internal view {
        assertEq(address(dca).balance, dca.totalDeposits(), "ETH held != deposits");
        assertEq(wif.balanceOf(address(dca)), 0, "DCA holds WIF");
    }
}

contract WiflyDCATest is DCABase {
    // ---------------------------------------------------------------- create / params

    function test_createPlan_storesEverything() public {
        vm.expectEmit(true, true, false, true);
        emit WiflyDCA.PlanCreated(1, alice, 1 ether, 0.01 ether, 1 hours, 0, 1_000_000e18, 100, 0, uint40(START));
        uint256 id = _create(alice, 1 ether);
        assertEq(id, 1);
        WiflyDCA.Plan memory p = dca.getPlan(id);
        assertEq(p.owner, alice);
        assertEq(p.balance, 1 ether);
        assertEq(p.amountPerBuy, 0.01 ether);
        assertEq(p.interval, 1 hours);
        assertEq(p.minWifPerEth, 1_000_000e18);
        assertEq(p.keeperTip, 0);
        assertEq(dca.totalDeposits(), 1 ether);
        assertEq(dca.plansOf(alice).length, 1);
        assertEq(dca.buysLeft(id), 100);
        assertEq(dca.floorWifOut(id), 10_000e18);
        assertEq(uint8(dca.status(id)), uint8(WiflyDCA.Skip.None));
        _assertBooks();
    }

    function test_createPlan_badParams() public {
        vm.startPrank(alice);
        vm.expectRevert(WiflyDCA.BadParams.selector); // interval < 1h
        dca.createPlan{value: 1 ether}(_params(0.01 ether, 1 hours - 1, 0, 1, 100, 0), 0);
        vm.expectRevert(WiflyDCA.BadParams.selector); // zero amount
        dca.createPlan{value: 1 ether}(_params(0, 1 hours, 0, 1, 100, 0), 0);
        vm.expectRevert(WiflyDCA.BadParams.selector); // no floor and no slippage cap
        dca.createPlan{value: 1 ether}(_params(0.01 ether, 1 hours, 0, 0, 0, 0), 0);
        vm.expectRevert(WiflyDCA.BadParams.selector); // slippage > 10%
        dca.createPlan{value: 1 ether}(_params(0.01 ether, 1 hours, 0, 0, 1_001, 0), 0);
        vm.expectRevert(WiflyDCA.BadParams.selector); // tip > amountPerBuy
        dca.createPlan{value: 1 ether}(_params(0.01 ether, 1 hours, 0, 1, 100, 0.01 ether + 1), 0);
        // floor only (no slippage) and slippage only (no floor) are both fine
        dca.createPlan{value: 1 ether}(_params(0.01 ether, 1 hours, 0, 1, 0, 0), 0);
        dca.createPlan{value: 1 ether}(_params(0.01 ether, 1 hours, 0, 0, 100, 0), 0);
        vm.stopPrank();
    }

    function test_plainEthTransferReverts() public {
        vm.prank(alice);
        (bool ok,) = address(dca).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ---------------------------------------------------------------- execute

    function test_execute_sendsWifStraightToOwner() public {
        uint256 id = _create(alice, 1 ether);
        uint256 q = _quote(id);
        vm.expectEmit(true, true, true, true);
        emit WiflyDCA.Bought(id, alice, keeper, 0.01 ether, q, 0, 1, 0.99 ether);
        vm.prank(keeper);
        uint256 got = dca.execute(id, q * 99 / 100);
        assertEq(got, q);
        assertEq(wif.balanceOf(alice), q);
        assertEq(router.lastRecipient(), alice);
        assertEq(address(router).balance, 0.01 ether);
        WiflyDCA.Plan memory p = dca.getPlan(id);
        assertEq(p.balance, 0.99 ether);
        assertEq(p.buysDone, 1);
        assertEq(p.lastBuyAt, START);
        assertEq(p.totalEthSpent, 0.01 ether);
        assertEq(p.totalWifBought, q);
        _assertBooks();
    }

    function test_execute_nonKeeperReverts() public {
        uint256 id = _create(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(WiflyDCA.NotKeeper.selector);
        dca.execute(id, 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(bob);
        vm.expectRevert(WiflyDCA.NotKeeper.selector);
        dca.executeBatch(ids, ids);
        // removed keeper
        vm.prank(owner);
        dca.setKeeper(keeper, false);
        vm.prank(keeper);
        vm.expectRevert(WiflyDCA.NotKeeper.selector);
        dca.execute(id, 1);
    }

    function test_setKeeper_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        dca.setKeeper(alice, true);
    }

    function test_intervalEnforced() public {
        uint256 id = _create(alice, 1 ether);
        uint256 min = _quote(id) * 99 / 100;
        vm.prank(keeper);
        dca.execute(id, min);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.NotDue));
        dca.execute(id, min);
        vm.warp(START + 1 hours - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.NotDue));
        dca.execute(id, min);
        assertEq(dca.nextBuyAt(id), START + 1 hours);
        vm.warp(START + 1 hours);
        vm.prank(keeper);
        dca.execute(id, min);
        assertEq(dca.getPlan(id).buysDone, 2);
    }

    function test_startAtInFuture() public {
        vm.prank(alice);
        uint256 id = dca.createPlan{value: 1 ether}(_params(0.01 ether, 1 days, 0, 1, 100, 0), uint40(START + 3 days));
        assertEq(uint8(dca.status(id)), uint8(WiflyDCA.Skip.NotDue));
        vm.warp(START + 3 days);
        uint256 q1 = _quote(id);
        vm.prank(keeper);
        dca.execute(id, q1);
    }

    function test_priceFloor_minWifOutBelowFloorReverts() public {
        uint256 id = _create(alice, 1 ether); // floor 10,000 WIF per 0.01 ETH
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.BelowFloor));
        dca.execute(id, 10_000e18 - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.BelowFloor));
        dca.execute(id, 0);
    }

    function test_priceFloor_priceCrashSkipsBuy() public {
        uint256 id = _create(alice, 1 ether);
        router.setRate(900_000e18); // WIF pumped: 0.01 ETH now buys < 10,000 WIF
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.SwapFailed));
        dca.execute(id, 10_000e18); // honest keeper passes the floor; the router can't meet it
        assertEq(dca.getPlan(id).balance, 1 ether);
        assertEq(wif.balanceOf(alice), 0);
        _assertBooks();
    }

    function test_noFloor_slippageCapVsOnchainQuote() public {
        vm.prank(alice);
        uint256 id = dca.createPlan{value: 1 ether}(_params(0.01 ether, 1 hours, 0, 0, 100, 0), 0);
        uint256 q = _quote(id);
        // a keeper can't pass a lax min
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.TooMuchSlippage));
        dca.execute(id, q * 98 / 100);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.BelowFloor));
        dca.execute(id, 0);
        vm.prank(keeper);
        dca.execute(id, q * 99 / 100);
        assertEq(wif.balanceOf(alice), q);
    }

    /// keepers compute min = quote * (1e4 - bps) / 1e4 (rounded down); that exact value must be accepted,
    /// one wei less must not (found on the fork: a strict cross-multiplied check rejected it by rounding)
    function testFuzz_slippageBoundaryRounding(uint256 quoted, uint16 slip) public {
        slip = uint16(bound(slip, 1, 1000));
        quoted = bound(quoted, 1e6, 1e30);
        quoter.setOverride(quoted);
        vm.prank(alice);
        uint256 id = dca.createPlan{value: 1 ether}(_params(0.01 ether, 1 hours, 0, 0, slip, 0), 0);
        uint256 min = quoted * (10_000 - slip) / 10_000;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.TooMuchSlippage));
        dca.execute(id, min - 1);
        // passes the price checks: either fills or (if the mock pool can't pay that much) fails in the swap
        if (min > router.out(0.01 ether)) {
            vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.SwapFailed));
        }
        vm.prank(keeper);
        dca.execute(id, min);
    }

    function test_quoterDown_skips() public {
        uint256 id = _create(alice, 1 ether);
        quoter.setBroken(true);
        uint256 q2 = _quote(id);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.QuoteFailed));
        dca.execute(id, q2);
    }

    function test_actualOutputChecked_evenIfRouterLies() public {
        uint256 id = _create(alice, 1 ether);
        router.setShortChange(true);
        uint256 min = _quote(id);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.ShortOutput));
        dca.execute(id, min);
        assertEq(dca.getPlan(id).balance, 1 ether);
    }

    function test_keeperTip_paidAndCapped() public {
        vm.prank(alice);
        uint256 id = dca.createPlan{value: 1 ether}(_params(0.01 ether, 1 hours, 0, 1, 100, 0.0001 ether), 0);
        uint256 q3 = _quote(id);
        vm.prank(keeper);
        dca.execute(id, q3);
        assertEq(keeper.balance, 0.0001 ether);
        assertEq(dca.getPlan(id).balance, 1 ether - 0.0101 ether);
        _assertBooks();
    }

    function test_defaultNoTip() public {
        uint256 id = _create(alice, 1 ether);
        uint256 q4 = _quote(id);
        vm.prank(keeper);
        dca.execute(id, q4);
        assertEq(keeper.balance, 0);
    }

    function test_maxBuysThenFinished() public {
        vm.prank(alice);
        uint256 id = dca.createPlan{value: 1 ether}(_params(0.01 ether, 1 hours, 2, 1, 100, 0), 0);
        for (uint256 i; i < 2; ++i) {
            uint256 q5 = _quote(id);
            vm.prank(keeper);
            dca.execute(id, q5);
            vm.warp(block.timestamp + 1 hours);
        }
        assertEq(dca.buysLeft(id), 0);
        uint256 q6 = _quote(id);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.Finished));
        dca.execute(id, q6);
        // leftover is withdrawable
        vm.prank(alice);
        dca.withdrawAll(id);
        assertEq(alice.balance, 100 ether - 0.02 ether);
        _assertBooks();
    }

    function test_runsUntilDepositRunsOut() public {
        uint256 id = _create(alice, 0.025 ether);
        for (uint256 i; i < 2; ++i) {
            uint256 q7 = _quote(id);
            vm.prank(keeper);
            dca.execute(id, q7);
            vm.warp(block.timestamp + 1 hours);
        }
        assertEq(dca.buysLeft(id), 0);
        uint256 q8 = _quote(id);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.LowBalance));
        dca.execute(id, q8);
        vm.prank(alice);
        dca.topUp{value: 0.005 ether}(id);
        uint256 q9 = _quote(id);
        vm.prank(keeper);
        dca.execute(id, q9);
        assertEq(dca.getPlan(id).balance, 0);
        _assertBooks();
    }

    // ---------------------------------------------------------------- owner controls

    function test_topUpEditPauseCancel() public {
        uint256 id = _create(alice, 1 ether);
        vm.startPrank(alice);
        dca.topUp{value: 0.5 ether}(id);
        assertEq(dca.getPlan(id).balance, 1.5 ether);
        dca.updatePlan(id, _params(0.02 ether, 1 days, 10, 0, 50, 0));
        WiflyDCA.Plan memory p = dca.getPlan(id);
        assertEq(p.amountPerBuy, 0.02 ether);
        assertEq(p.interval, 1 days);
        assertEq(p.maxBuys, 10);
        dca.setPlanPaused(id, true);
        vm.stopPrank();

        uint256 q10 = _quote(id);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.PlanPaused));
        dca.execute(id, q10);

        vm.startPrank(alice);
        dca.setPlanPaused(id, false);
        dca.cancelPlan(id);
        assertEq(alice.balance, 100 ether);
        vm.expectRevert(WiflyDCA.PlanIsCancelled.selector);
        dca.topUp{value: 1}(id);
        vm.expectRevert(WiflyDCA.PlanIsCancelled.selector);
        dca.cancelPlan(id);
        vm.stopPrank();
        assertEq(dca.buysLeft(id), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.Cancelled));
        dca.execute(id, 1);
        _assertBooks();
    }

    function test_onlyPlanOwnerCanManage() public {
        uint256 id = _create(alice, 1 ether);
        vm.startPrank(bob);
        vm.expectRevert(WiflyDCA.NotPlanOwner.selector);
        dca.withdraw(id, 1);
        vm.expectRevert(WiflyDCA.NotPlanOwner.selector);
        dca.withdrawAll(id);
        vm.expectRevert(WiflyDCA.NotPlanOwner.selector);
        dca.cancelPlan(id);
        vm.expectRevert(WiflyDCA.NotPlanOwner.selector);
        dca.topUp{value: 1}(id);
        vm.expectRevert(WiflyDCA.NotPlanOwner.selector);
        dca.setPlanPaused(id, true);
        vm.expectRevert(WiflyDCA.NotPlanOwner.selector);
        dca.updatePlan(id, _params(1, 1 hours, 0, 1, 0, 0));
        vm.stopPrank();
        // even the contract owner can't touch user funds
        vm.prank(owner);
        vm.expectRevert(WiflyDCA.NotPlanOwner.selector);
        dca.withdrawAll(id);
    }

    function test_withdrawPartialAndOverdraw() public {
        uint256 id = _create(alice, 1 ether);
        vm.startPrank(alice);
        dca.withdraw(id, 0.4 ether);
        assertEq(dca.getPlan(id).balance, 0.6 ether);
        vm.expectRevert(WiflyDCA.BadParams.selector);
        dca.withdraw(id, 0.6 ether + 1);
        vm.expectRevert(WiflyDCA.BadParams.selector);
        dca.withdraw(id, 0);
        vm.stopPrank();
        _assertBooks();
    }

    function test_pause_blocksOnlyExecuteAndNewPlans() public {
        uint256 id = _create(alice, 1 ether);
        vm.prank(owner);
        dca.pause();

        uint256 q11 = _quote(id);
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        dca.execute(id, q11);
        uint256[] memory ids = new uint256[](1);
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        dca.executeBatch(ids, ids);
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        dca.createPlan{value: 1 ether}(_params(0.01 ether, 1 hours, 0, 1, 0, 0), 0);

        vm.startPrank(alice);
        dca.topUp{value: 1 ether}(id);
        dca.updatePlan(id, _params(0.02 ether, 2 hours, 0, 1, 0, 0));
        dca.setPlanPaused(id, true);
        dca.withdraw(id, 0.5 ether);
        dca.cancelPlan(id);
        vm.stopPrank();
        assertEq(alice.balance, 100 ether);
        _assertBooks();

        vm.prank(owner);
        dca.unpause();
        _create(bob, 1 ether);
    }

    // ---------------------------------------------------------------- batch

    function test_batch_skipsInsteadOfReverting() public {
        uint256[] memory ids = new uint256[](7);
        uint256[] memory mins = new uint256[](7);
        ids[0] = _create(alice, 1 ether); // due
        ids[1] = _create(bob, 1 ether); // not due (bought below)
        ids[2] = _create(alice, 1 ether); // paused
        ids[3] = _create(bob, 0.001 ether); // low balance
        ids[4] = _create(alice, 1 ether); // min below floor
        ids[5] = _create(bob, 1 ether); // min too lax vs quote
        ids[6] = 999; // no plan
        uint256 q = _quote(ids[0]);
        vm.prank(keeper);
        dca.execute(ids[1], q);
        vm.prank(alice);
        dca.setPlanPaused(ids[2], true);
        for (uint256 i; i < 7; ++i) {
            mins[i] = q * 99 / 100;
        }
        mins[4] = 1;
        mins[5] = q * 90 / 100;

        vm.recordLogs();
        vm.prank(keeper);
        assertEq(dca.executeBatch(ids, mins), 1);
        _checkSkips(ids);
        assertEq(dca.getPlan(ids[0]).buysDone, 1);
        _assertBooks();
    }

    function _checkSkips(uint256[] memory ids) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint8[6] memory want = [
            uint8(WiflyDCA.Skip.NotDue),
            uint8(WiflyDCA.Skip.PlanPaused),
            uint8(WiflyDCA.Skip.LowBalance),
            uint8(WiflyDCA.Skip.BelowFloor),
            uint8(WiflyDCA.Skip.TooMuchSlippage),
            uint8(WiflyDCA.Skip.NoPlan)
        ];
        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != WiflyDCA.Skipped.selector) continue;
            assertEq(abi.decode(logs[i].data, (uint8)), want[k], "skip reason");
            assertEq(uint256(logs[i].topics[1]), ids[k + 1], "skip id");
            ++k;
        }
        assertEq(k, 6);
    }

    function test_batch_failedSwapRolledBackOthersGo() public {
        uint256 a = _create(alice, 1 ether);
        uint256 b = _create(bob, 1 ether);
        uint256 q = _quote(a);
        uint256[] memory ids = new uint256[](2);
        uint256[] memory mins = new uint256[](2);
        (ids[0], mins[0]) = (a, q + 1); // router can't meet it -> SwapFailed, skipped
        (ids[1], mins[1]) = (b, q);
        vm.expectEmit(true, false, false, true);
        emit WiflyDCA.Skipped(a, WiflyDCA.Skip.SwapFailed);
        vm.prank(keeper);
        assertEq(dca.executeBatch(ids, mins), 1);
        WiflyDCA.Plan memory pa = dca.getPlan(a);
        assertEq(pa.balance, 1 ether);
        assertEq(pa.buysDone, 0);
        assertEq(pa.lastBuyAt, 0);
        assertEq(uint8(dca.status(a)), uint8(WiflyDCA.Skip.None)); // still due
        assertEq(wif.balanceOf(bob), q);
        _assertBooks();
    }

    function test_batch_lengthMismatch() public {
        vm.prank(keeper);
        vm.expectRevert(WiflyDCA.LengthMismatch.selector);
        dca.executeBatch(new uint256[](2), new uint256[](1));
    }

    // ---------------------------------------------------------------- reentrancy / admin

    function test_reentrancyDuringSwapBlocked() public {
        uint256 id = _create(alice, 1 ether);
        // router tries to call back into withdrawAll mid-swap; the guard reverts it, so the swap fails and rolls back
        router.setReenter(address(dca), abi.encodeCall(WiflyDCA.withdrawAll, (id)));
        vm.expectCall(address(dca), abi.encodeCall(WiflyDCA.withdrawAll, (id)));
        uint256 q12 = _quote(id);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.SwapFailed));
        dca.execute(id, q12);
        // same in a batch: skipped, nothing moved
        uint256 q13 = _quote(id);
        vm.prank(keeper);
        assertEq(dca.executeBatch(_one(id), _one(q13)), 0);
        assertEq(dca.getPlan(id).balance, 1 ether);
        assertEq(alice.balance, 99 ether);
        // and without the reentry the same buy goes through
        router.setReenter(address(0), "");
        uint256 q14 = _quote(id);
        vm.prank(keeper);
        dca.execute(id, q14);
        _assertBooks();
    }

    function test_reentrancyGuard_direct() public {
        // re-entering execute from the router is also blocked (keeper check comes after the guard)
        uint256 id = _create(alice, 1 ether);
        router.setReenter(address(dca), abi.encodeCall(WiflyDCA.execute, (id, 1)));
        uint256 q15 = _quote(id);
        vm.prank(keeper);
        assertEq(dca.executeBatch(_one(id), _one(q15)), 0);
        assertEq(dca.getPlan(id).buysDone, 0);
    }

    function _one(uint256 x) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = x;
    }

    function test_sweepExcessEth_onlyExcess() public {
        _create(alice, 1 ether);
        vm.deal(address(dca), address(dca).balance + 0.3 ether); // forced ETH (selfdestruct-style)
        vm.prank(owner);
        dca.sweepExcessEth(owner);
        assertEq(owner.balance, 0.3 ether);
        _assertBooks();
    }

    function test_rescueToken() public {
        wif.mint(address(dca), 5e18);
        vm.prank(owner);
        dca.rescueToken(address(wif), owner, 5e18);
        assertEq(wif.balanceOf(owner), 5e18);
    }

    function test_ownable2Step() public {
        vm.prank(owner);
        dca.transferOwnership(bob);
        assertEq(dca.owner(), owner);
        vm.prank(bob);
        dca.acceptOwnership();
        assertEq(dca.owner(), bob);
    }

    function test_poolKeyMatchesLivePool() public view {
        (address c0, address c1, uint24 fee, int24 ts, address h) = (
            dca.poolKey().currency0,
            dca.poolKey().currency1,
            dca.poolKey().fee,
            dca.poolKey().tickSpacing,
            dca.poolKey().hooks
        );
        assertEq(c0, address(0));
        assertEq(c1, address(wif));
        assertEq(fee, 0);
        assertEq(ts, 200);
        assertEq(h, hooks);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_floorMath(uint128 amt, uint256 floor) public {
        amt = uint128(bound(amt, 1e9, 10 ether));
        floor = bound(floor, 1, 10_000_000e18);
        vm.prank(alice);
        uint256 id = dca.createPlan{value: amt}(_params(amt, 1 hours, 0, floor, 0, 0), 0);
        uint256 f = dca.floorWifOut(id);
        assertGe(f * 1e18, uint256(amt) * floor); // rounds up: never below the user's floor
        uint256 out = router.out(amt);
        vm.prank(keeper);
        if (out >= f && f > 0) {
            dca.execute(id, f);
            assertEq(wif.balanceOf(alice), out);
        } else {
            vm.expectRevert();
            dca.execute(id, f);
            assertEq(dca.getPlan(id).balance, amt);
        }
        _assertBooks();
    }
}
