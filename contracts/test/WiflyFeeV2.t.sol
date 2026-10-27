// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Wifly} from "../src/Wifly.sol";
import {WiflyBase} from "./utils/WiflyBase.sol";

/// @notice Fee split tests: 90% to the community pot, 10% burned, per fee source, plus weekly-pot timing.
contract WiflyFeeV2Test is WiflyBase {
    bytes32 internal constant POST = keccak256("post-1");
    bytes32 internal constant HANDLE = keccak256("x:marv");

    uint256 internal supply0;
    uint256 internal pot0;

    function setUp() public override {
        super.setUp();
        supply0 = token.totalSupply();
    }

    /// @dev Snapshot before a fee-paying call.
    function _snap() internal {
        supply0 = token.totalSupply();
        pot0 = w.epochPot();
    }

    /// @dev The last call's fee went exactly 90% (+ dust) to the pot and 10% (rounded down) burned; 0 to anyone else.
    function _assertSplit(uint256 fee) internal view {
        uint256 burn = fee * 1_000 / 10_000;
        assertEq(supply0 - token.totalSupply(), burn, "burn != 10%");
        assertEq(w.epochPot() - pot0, fee - burn, "pot != 90% + dust");
        assertEq(token.balanceOf(treasury), 0, "treasury got WIF");
        assertEq(token.balanceOf(owner), 0, "owner got WIF");
        _assertSolvent();
    }

    function test_v2_tip_2pct() public {
        _snap();
        uint256 bobWallet = token.balanceOf(bob);
        vm.expectEmit(address(w));
        emit Wifly.FeeSplit(1.8e18, 0.2e18);
        vm.prank(alice);
        w.tip(bob, 100e18, POST);
        assertEq(token.balanceOf(bob) - bobWallet, 98e18); // recipient still gets 98% directly
        _assertSplit(2e18);
    }

    function test_v2_tipFromDeposit_2pct() public {
        vm.prank(alice);
        w.deposit(500e18);
        _snap();
        vm.prank(alice);
        w.tipFor(alice, bob, 500e18, POST);
        _assertSplit(10e18);
    }

    function test_v2_unlinkedHandleTip_2pct() public {
        _snap();
        vm.prank(alice);
        w.tipHandle(HANDLE, 100e18, POST);
        assertEq(w.handleEscrow(HANDLE), 98e18);
        _assertSplit(2e18);
        // linking later releases the escrowed 98 with no second fee
        uint256 d = block.timestamp + 1 hours;
        bytes memory sig = _sign(HANDLE, carol, d);
        uint256 carolWallet = token.balanceOf(carol);
        _snap();
        vm.prank(carol);
        w.linkHandle(HANDLE, d, sig);
        assertEq(token.balanceOf(carol) - carolWallet + w.balances(carol), 98e18);
        _assertSplit(0);
    }

    function test_v2_linkedHandleTip_2pct() public {
        uint256 d = block.timestamp + 1 hours;
        bytes memory sig = _sign(HANDLE, carol, d);
        vm.prank(carol);
        w.linkHandle(HANDLE, d, sig);
        _snap();
        uint256 carolWallet = token.balanceOf(carol);
        vm.prank(alice);
        w.tipHandle(HANDLE, 100e18, POST);
        assertEq(token.balanceOf(carol) - carolWallet, 98e18);
        _assertSplit(2e18);
    }

    function test_v2_subscribe_2pct() public {
        vm.prank(bob);
        w.setTier(0, 50e18);
        _snap();
        vm.prank(alice);
        w.subscribe(bob, 0);
        _assertSplit(1e18);
    }

    function test_v2_renew_2pct() public {
        vm.prank(bob);
        w.setTier(0, 50e18);
        vm.startPrank(alice);
        w.subscribe(bob, 0);
        w.setAutoRenew(bob, 0, 0, 50e18);
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days);
        _snap();
        w.renew(alice, bob); // anyone (keeper) can call
        _assertSplit(1e18);
    }

    function test_v2_plus_monthlyAndYearly_2pct() public {
        address plus = makeAddr("PLUS_CREATOR_ADDRESS");
        vm.startPrank(plus);
        w.setTier(0, 1_500e18);
        w.setYearlyPrice(0, 15_000e18);
        vm.stopPrank();
        _snap();
        vm.prank(alice);
        w.subscribe(plus, 0); // 1500 WIF month
        _assertSplit(30e18); // 27 pot, 3 burned
        _snap();
        vm.prank(bob);
        w.subscribePlan(plus, 0, 1); // 15000 WIF year
        _assertSplit(300e18); // 270 pot, 30 burned
    }

    function test_v2_unlock_2pct() public {
        vm.prank(bob);
        w.setContentPrice(POST, 50e18);
        _snap();
        vm.prank(alice);
        w.unlock(bob, POST);
        _assertSplit(1e18);
    }

    function test_v2_pay_2pct() public {
        _snap();
        vm.prank(alice);
        w.pay(bob, 200e18, keccak256("order"));
        assertEq(w.balances(bob), 196e18);
        _assertSplit(4e18);
    }

    function test_v2_vote_100pct() public {
        _snap();
        vm.prank(alice);
        w.vote(POST, bob, 10e18);
        _assertSplit(10e18); // 9 pot, 1 burned
    }

    function test_v2_topSpot_first100_then10pct() public {
        _snap();
        vm.prank(alice);
        w.takeTopSpot(POST, 100e18);
        _assertSplit(100e18); // empty spot: whole bid is the fee
        vm.warp(block.timestamp + 60);
        _snap();
        vm.prank(bob);
        w.takeTopSpot(POST, 200e18);
        assertEq(w.balances(alice), 180e18); // outbid holder gets 90% back
        _assertSplit(20e18); // 10% slice: 18 pot, 2 burned
    }

    function test_v2_feeBpsUnchanged() public view {
        assertEq(w.feeBps(), 200);
        (uint256 fee, uint256 p, uint256 b, uint256 net) = w.quoteFee(100e18);
        assertEq(fee, 2e18);
        assertEq(p, 1.8e18);
        assertEq(b, 0.2e18);
        assertEq(net, 98e18);
    }

    // ---------------------------------------------------------------- weekly pot + finalizeEpoch
    function test_v2_finalizeEpoch_paysWholeWeekPot() public {
        uint256 ep = w.currentEpoch();
        vm.prank(alice);
        w.tip(carol, 1_000e18, POST); // pot +18
        vm.prank(alice);
        w.vote(POST, bob, 100e18); // pot +90
        assertEq(w.epochPot(), 108e18);
        assertEq(w.payablePot(), 0); // nothing payable while the week is still running
        vm.warp(w.epochEndsAt(ep));
        assertEq(w.payablePot(), 108e18);
        vm.expectEmit(address(w));
        emit Wifly.EpochFinalized(ep, bob, 54e18, 54e18);
        w.finalizeEpoch(ep, bob);
        assertEq(w.balances(bob), 54e18);
        vm.prank(alice);
        assertEq(w.claimVoterReward(ep), 54e18);
        assertEq(w.epochPot(), 0);
        _assertSolvent();
    }

    function test_v2_feesAfterWeekEnd_goToNextWeek() public {
        uint256 ep = w.currentEpoch();
        vm.prank(alice);
        w.vote(POST, bob, 100e18); // week ep: pot 90
        vm.warp(w.epochEndsAt(ep) + 1 hours);
        // fees in week ep+1, before anyone finalizes ep
        vm.prank(alice);
        w.vote(POST, carol, 50e18); // pot +45
        vm.prank(alice);
        w.tip(bob, 1_000e18, POST); // pot +18
        assertEq(w.epochPot(), 153e18);
        assertEq(w.potInCurrent(), 63e18);
        assertEq(w.payablePot(), 90e18);
        w.finalizeEpoch(ep, bob);
        (,,,, uint256 pool) = w.epochs(ep);
        assertEq(pool, 45e18);
        assertEq(w.balances(bob), 45e18); // only week ep's 90, not the 63 that came in after
        assertEq(w.epochPot(), 63e18);
        assertEq(w.payablePot(), 0);
        // next week: ep+1's 63 is payable to its winner
        vm.warp(w.epochEndsAt(ep + 1));
        assertEq(w.payablePot(), 63e18);
        w.finalizeEpoch(ep + 1, carol);
        assertEq(w.balances(carol), 31.5e18);
        assertEq(w.epochPot(), 0);
        _assertSolvent();
    }

    function test_v2_emptyWeekRollsOver() public {
        uint256 ep = w.currentEpoch();
        vm.prank(alice);
        w.tip(bob, 1_000e18, POST); // week ep: pot 18, no votes
        vm.warp(w.epochEndsAt(ep));
        vm.expectRevert(Wifly.NoVotes.selector);
        w.finalizeEpoch(ep, address(0));
        vm.prank(alice);
        w.vote(POST, carol, 10e18); // week ep+1: pot +9
        assertEq(w.payablePot(), 18e18);
        vm.warp(w.epochEndsAt(ep + 1));
        assertEq(w.payablePot(), 27e18); // the empty week's 18 rolled into ep+1
        w.finalizeEpoch(ep + 1, carol);
        assertEq(w.balances(carol), 13.5e18);
        _assertSolvent();
    }

    function test_v2_fundPotCountsAsCurrentWeek() public {
        uint256 ep = w.currentEpoch();
        vm.prank(alice);
        w.vote(POST, bob, 10e18); // 9
        vm.warp(w.epochEndsAt(ep));
        vm.prank(carol);
        w.fundPot(100e18); // arrives in ep+1
        assertEq(w.payablePot(), 9e18);
        w.finalizeEpoch(ep, bob);
        assertEq(w.epochPot(), 100e18);
    }

    function testFuzz_v2_payableNeverExceedsPot(uint96 a, uint96 b, uint32 gap) public {
        uint256 x = bound(a, 1, 100_000e18);
        uint256 y = bound(b, 1, 100_000e18);
        uint256 ep = w.currentEpoch();
        vm.prank(alice);
        w.vote(POST, bob, x);
        vm.warp(block.timestamp + bound(gap, 0, 20 days));
        vm.prank(carol);
        w.vote(POST, alice, y);
        assertLe(w.payablePot(), w.epochPot());
        if (w.currentEpoch() > ep) {
            w.finalizeEpoch(ep, bob);
            assertLe(w.payablePot(), w.epochPot());
            _assertSolvent();
        }
    }
}
