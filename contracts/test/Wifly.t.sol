// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Wifly} from "../src/Wifly.sol";
import {MockNoBurn} from "./mocks/MockWIF.sol";
import {WiflyBase} from "./utils/WiflyBase.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Proxies} from "./utils/Proxies.sol";

contract WiflyTest is WiflyBase {
    bytes32 constant POST = keccak256("post-1");
    bytes32 constant HANDLE = keccak256("x:123456789");

    // ------------------------------------------------------------------ tips
    function test_tip_splitsFee() public {
        uint256 supply = token.totalSupply();
        vm.expectEmit(address(w));
        emit Wifly.Tipped(alice, bob, POST, 100e18, 2e18);
        uint256 bobWallet = token.balanceOf(bob);
        vm.prank(alice);
        w.tip(bob, 100e18, POST);
        // 2e18 fee: 1.8e18 pot, 0.2e18 burned, 0 treasury; the 98e18 net lands straight in bob's wallet
        assertEq(token.balanceOf(bob), bobWallet + 98e18);
        assertEq(w.balances(bob), 0);
        assertEq(w.totalBalances(), 0);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(w.communityPot(), 1.8e18);
        assertEq(w.epochPot(), 1.8e18);
        assertEq(w.totalBurned(), 0.2e18);
        assertEq(token.totalSupply(), supply - 0.2e18);
        assertEq(token.balanceOf(address(w)), w.totalLiabilities()); // treasury share never sits in the contract
        _assertSolvent();
    }

    // ------------------------------------------------------------------ direct tips
    function test_tip_paidStraightToWallet() public {
        uint256 bobWallet = token.balanceOf(bob);
        uint256 aliceWallet = token.balanceOf(alice);
        vm.prank(alice);
        w.tip(bob, 1_000e18, POST);
        assertEq(token.balanceOf(bob), bobWallet + 980e18);
        assertEq(token.balanceOf(alice), aliceWallet - 1_000e18);
        assertEq(w.balances(bob), 0);
        assertEq(w.totalBalances(), 0);
        // only the pot share stays in the contract
        assertEq(token.balanceOf(address(w)), w.epochPot());
        assertEq(token.balanceOf(address(w)), w.totalLiabilities());
        // nothing for bob to withdraw
        vm.prank(bob);
        vm.expectRevert(Wifly.ZeroAmount.selector);
        w.withdraw();
    }

    function test_tipFor_spendsDepositPaysCreatorWallet() public {
        vm.startPrank(alice);
        w.deposit(500e18);
        w.setAgent(agent, 200e18);
        vm.stopPrank();
        uint256 bobWallet = token.balanceOf(bob);

        // user spends their own deposit
        vm.expectEmit(address(w));
        emit Wifly.Tipped(alice, bob, POST, 100e18, 2e18);
        vm.prank(alice);
        w.tipFor(alice, bob, 100e18, POST);
        assertEq(w.balances(alice), 400e18);
        assertEq(token.balanceOf(bob), bobWallet + 98e18);
        assertEq(w.balances(bob), 0);

        // agent spends it too (cap applies), still paid to bob's wallet
        vm.prank(agent);
        w.tipFor(alice, bob, 200e18, POST);
        assertEq(w.balances(alice), 200e18);
        assertEq(token.balanceOf(bob), bobWallet + 98e18 + 196e18);
        assertEq(w.balances(bob), 0);
        assertEq(w.totalBalances(), 200e18);
        assertEq(token.balanceOf(address(w)), w.totalLiabilities());
        _assertSolvent();
    }

    function test_handleTip_escrowThenLinkPaysWallet() public {
        vm.prank(alice);
        w.tipHandle(HANDLE, 100e18, POST);
        vm.prank(bob);
        w.tipHandle(HANDLE, 50e18, POST);
        assertEq(w.handleEscrow(HANDLE), 98e18 + 49e18);

        uint256 carolWallet = token.balanceOf(carol);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(HANDLE, carol, deadline);
        vm.prank(carol);
        w.linkHandle(HANDLE, deadline, sig);
        assertEq(token.balanceOf(carol), carolWallet + 147e18);
        assertEq(w.balances(carol), 0);
        assertEq(w.handleEscrow(HANDLE), 0);
        assertEq(w.totalEscrow(), 0);
        assertEq(token.balanceOf(address(w)), w.totalLiabilities());

        // escrow can't be released twice: re-linking to another wallet pays nothing more
        sig = _sign(HANDLE, bob, deadline);
        uint256 bobWallet = token.balanceOf(bob);
        vm.expectEmit(address(w));
        emit Wifly.HandleLinked(HANDLE, bob, 0);
        vm.prank(bob);
        w.linkHandle(HANDLE, deadline, sig);
        assertEq(token.balanceOf(bob), bobWallet);
        assertEq(token.balanceOf(carol), carolWallet + 147e18);

        // tipped escrow ids are released, so the tipper can't refund them later
        vm.warp(block.timestamp + 31 days);
        vm.prank(alice);
        vm.expectRevert(Wifly.RefundNotAvailable.selector);
        w.refundHandleTip(1);
        _assertSolvent();
    }

    function test_handleTip_refundStillCreditsTipperBalance() public {
        vm.prank(alice);
        uint256 id = w.tipHandle(HANDLE, 100e18, POST);
        vm.warp(block.timestamp + 30 days);
        vm.prank(alice);
        w.refundHandleTip(id);
        assertEq(w.balances(alice), 98e18); // refunds (not tips) stay withdrawable from the balance
        assertEq(w.totalEscrow(), 0);
        assertEq(token.balanceOf(address(w)), w.totalLiabilities());
    }

    function test_tip_reverts() public {
        vm.startPrank(alice);
        vm.expectRevert(Wifly.SelfPayment.selector);
        w.tip(alice, 1e18, POST);
        vm.expectRevert(Wifly.ZeroAddress.selector);
        w.tip(address(0), 1e18, POST);
        vm.expectRevert(Wifly.ZeroAmount.selector);
        w.tip(bob, 0, POST);
        vm.stopPrank();
    }

    function test_withdraw() public {
        vm.prank(bob);
        w.deposit(98e18);
        uint256 before = token.balanceOf(bob);
        vm.expectEmit(address(w));
        emit Wifly.Withdrawn(bob, 98e18);
        vm.prank(bob);
        w.withdraw();
        assertEq(token.balanceOf(bob), before + 98e18);
        assertEq(w.balances(bob), 0);
        vm.prank(bob);
        vm.expectRevert(Wifly.ZeroAmount.selector);
        w.withdraw();
    }

    function test_withdrawAmount_partial() public {
        vm.prank(alice);
        w.deposit(50e18);
        vm.prank(alice);
        w.withdrawAmount(20e18);
        assertEq(w.balances(alice), 30e18);
        vm.prank(alice);
        vm.expectRevert(Wifly.InsufficientBalance.selector);
        w.withdrawAmount(31e18);
    }

    // ------------------------------------------------------------------ handle escrow
    function test_handleTip_escrowAndLink() public {
        vm.prank(alice);
        uint256 id = w.tipHandle(HANDLE, 100e18, POST);
        assertEq(id, 1);
        assertEq(w.handleEscrow(HANDLE), 98e18);
        assertEq(w.totalEscrow(), 98e18);

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(HANDLE, carol, deadline);
        uint256 carolWallet = token.balanceOf(carol);
        vm.expectEmit(address(w));
        emit Wifly.HandleLinked(HANDLE, carol, 98e18);
        vm.prank(carol);
        w.linkHandle(HANDLE, deadline, sig);
        assertEq(w.handleOwner(HANDLE), carol);
        // released escrow goes straight to carol's wallet, not her in-contract balance
        assertEq(token.balanceOf(carol), carolWallet + 98e18);
        assertEq(w.balances(carol), 0);
        assertEq(w.totalEscrow(), 0);

        // later tips go straight to the linked account's wallet
        vm.expectEmit(address(w));
        emit Wifly.Tipped(bob, carol, POST, 100e18, 2e18);
        vm.prank(bob);
        assertEq(w.tipHandle(HANDLE, 100e18, POST), 0);
        assertEq(token.balanceOf(carol), carolWallet + 196e18);
        assertEq(w.balances(carol), 0);
        _assertSolvent();
    }

    function test_link_rejectsBadSigReplayAndExpiry() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(HANDLE, carol, deadline);

        // wrong sender: signature is bound to carol
        vm.prank(bob);
        vm.expectRevert(Wifly.BadSignature.selector);
        w.linkHandle(HANDLE, deadline, sig);

        vm.prank(carol);
        w.linkHandle(HANDLE, deadline, sig);

        // replay after relink to someone else fails (nonce bumped)
        bytes memory sigBob = _sign(HANDLE, bob, deadline);
        vm.prank(bob);
        w.linkHandle(HANDLE, deadline, sigBob);
        vm.prank(carol);
        vm.expectRevert(Wifly.BadSignature.selector);
        w.linkHandle(HANDLE, deadline, sig);

        // expired
        bytes memory late = _sign(HANDLE, carol, block.timestamp);
        vm.warp(block.timestamp + 1);
        vm.prank(carol);
        vm.expectRevert(Wifly.Expired.selector);
        w.linkHandle(HANDLE, block.timestamp - 1, late);
    }

    function test_link_rejectsNonAttester() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = w.linkDigest(HANDLE, carol, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        vm.prank(carol);
        vm.expectRevert(Wifly.BadSignature.selector);
        w.linkHandle(HANDLE, deadline, abi.encodePacked(r, s, v));
    }

    function test_handleRefund_afterDelay() public {
        vm.prank(alice);
        uint256 id = w.tipHandle(HANDLE, 100e18, POST);

        vm.prank(alice);
        vm.expectRevert(Wifly.RefundNotAvailable.selector);
        w.refundHandleTip(id);

        vm.prank(bob);
        vm.expectRevert(Wifly.NotTipper.selector);
        w.refundHandleTip(id);

        vm.warp(block.timestamp + 30 days);
        vm.prank(alice);
        w.refundHandleTip(id);
        assertEq(w.balances(alice), 98e18);
        assertEq(w.totalEscrow(), 0);

        vm.prank(alice);
        vm.expectRevert(Wifly.RefundNotAvailable.selector);
        w.refundHandleTip(id);
        _assertSolvent();
    }

    function test_handleRefund_blockedOnceLinked() public {
        vm.prank(alice);
        uint256 id = w.tipHandle(HANDLE, 100e18, POST);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(HANDLE, carol, deadline);
        vm.prank(carol);
        w.linkHandle(HANDLE, deadline, sig);
        vm.warp(block.timestamp + 31 days);
        vm.prank(alice);
        vm.expectRevert(Wifly.RefundNotAvailable.selector);
        w.refundHandleTip(id);
    }

    // ------------------------------------------------------------------ subscriptions
    function test_subscribe_andExtend() public {
        vm.prank(bob);
        w.setTier(1, 500e18);
        vm.prank(alice);
        w.subscribe(bob, 1);
        (bool active, uint8 tier, uint64 expiry) = w.isSubscribed(alice, bob);
        assertTrue(active);
        assertEq(tier, 1);
        assertEq(expiry, block.timestamp + 30 days);
        assertEq(w.balances(bob), 490e18);

        vm.warp(block.timestamp + 10 days);
        vm.prank(alice);
        w.subscribe(bob, 1);
        (,, expiry) = w.isSubscribed(alice, bob);
        assertEq(expiry, START + 60 days);

        vm.warp(START + 61 days);
        (active,,) = w.isSubscribed(alice, bob);
        assertFalse(active);
    }

    function test_subscribe_tierChangeRestartsPeriod() public {
        vm.startPrank(bob);
        w.setTier(0, 100e18);
        w.setTier(2, 1000e18);
        vm.stopPrank();
        vm.startPrank(alice);
        w.subscribe(bob, 0);
        w.subscribe(bob, 0); // 60 days on tier 0
        w.subscribe(bob, 2); // upgrade: fresh 30 days, no stacking
        vm.stopPrank();
        (, uint8 tier, uint64 expiry) = w.isSubscribed(alice, bob);
        assertEq(tier, 2);
        assertEq(expiry, START + 30 days);
    }

    function test_subscribe_reverts() public {
        vm.prank(alice);
        vm.expectRevert(Wifly.TierDisabled.selector);
        w.subscribe(bob, 0);
        vm.prank(alice);
        vm.expectRevert(Wifly.InvalidTier.selector);
        w.subscribe(bob, 3);
        vm.prank(bob);
        vm.expectRevert(Wifly.InvalidTier.selector);
        w.setTier(3, 1);
        vm.prank(alice);
        w.setTier(0, 1e18);
        vm.prank(alice);
        vm.expectRevert(Wifly.SelfPayment.selector);
        w.subscribe(alice, 0);
    }

    // ------------------------------------------------------------------ unlocks & pay
    function test_unlock() public {
        bytes32 cid = keccak256("photo");
        vm.prank(bob);
        w.setContentPrice(cid, 50e18);
        vm.prank(alice);
        w.unlock(bob, cid);
        assertTrue(w.hasUnlocked(alice, bob, cid));
        assertEq(w.balances(bob), 49e18);
        vm.prank(alice);
        vm.expectRevert(Wifly.AlreadyUnlocked.selector);
        w.unlock(bob, cid);
        vm.prank(alice);
        vm.expectRevert(Wifly.NotForSale.selector);
        w.unlock(carol, cid); // namespaced: carol never priced it
    }

    function test_pay() public {
        bytes32 order = keccak256("order-7");
        vm.expectEmit(address(w));
        emit Wifly.Paid(alice, bob, order, 200e18, 4e18);
        vm.prank(alice);
        w.pay(bob, 200e18, order);
        assertEq(w.balances(bob), 196e18);
    }

    // ------------------------------------------------------------------ top spot
    function test_topSpot_flow() public {
        bytes32 p2 = keccak256("p2");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Wifly.BidTooLow.selector, FLOOR));
        w.takeTopSpot(POST, FLOOR - 1);

        vm.prank(alice);
        w.takeTopSpot(POST, FLOOR);
        // empty spot: the whole 100e18 is split: 90 pot, 10 burned, 0 treasury
        assertEq(token.balanceOf(treasury), 0);
        assertEq(w.epochPot(), 90e18);
        assertEq(w.totalBurned(), 10e18);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Wifly.TopSpotLocked.selector, START + 60));
        w.takeTopSpot(p2, 200e18);

        vm.warp(START + 60);
        assertEq(w.minTopSpotBid(), 110e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Wifly.BidTooLow.selector, 110e18));
        w.takeTopSpot(p2, 109e18);

        vm.expectEmit(address(w));
        emit Wifly.TopSpotTaken(bob, p2, 110e18, alice, 99e18);
        vm.prank(bob);
        w.takeTopSpot(p2, 110e18);
        assertEq(w.balances(alice), 99e18);
        // the 11e18 slice: 9.9 pot, 1.1 burned
        assertEq(token.balanceOf(treasury), 0);
        assertEq(w.epochPot(), 99.9e18);
        assertEq(w.totalBurned(), 11.1e18);
        (address holder,, bytes32 pid, uint256 amt) = w.topSpot();
        assertEq(holder, bob);
        assertEq(pid, p2);
        assertEq(amt, 110e18);
        _assertSolvent();
    }

    function test_topSpot_params() public {
        vm.prank(owner);
        vm.expectRevert(Wifly.HoldTooLong.selector);
        w.setTopSpotParams(1, 1 days + 1);
        vm.prank(owner);
        w.setTopSpotParams(5e18, 0);
        assertEq(w.minTopSpotBid(), 5e18);
    }

    // ------------------------------------------------------------------ agents
    function test_agent_spendsDepositWithinCap() public {
        vm.startPrank(alice);
        w.deposit(1000e18);
        w.setAgent(agent, 150e18);
        vm.stopPrank();
        vm.prank(bob);
        w.setTier(0, 100e18);

        vm.prank(agent);
        w.subscribeFor(alice, bob, 0);
        vm.prank(agent);
        w.tipFor(alice, bob, 50e18, POST);
        assertEq(w.agentRemaining(alice), 0);
        vm.prank(agent);
        vm.expectRevert(Wifly.AgentCapExceeded.selector);
        w.tipFor(alice, bob, 1, POST);

        // new day resets the cap
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        w.takeTopSpotFor(alice, POST, FLOOR);
        assertEq(w.balances(alice), 1000e18 - 250e18);
        (address holder,,,) = w.topSpot();
        assertEq(holder, alice);
    }

    function test_agent_cannotWithdrawOrActForOthers() public {
        vm.startPrank(alice);
        w.deposit(1000e18);
        w.setAgent(agent, 1000e18);
        vm.stopPrank();
        // withdraw only ever pays msg.sender's own balance
        vm.prank(agent);
        vm.expectRevert(Wifly.ZeroAmount.selector);
        w.withdraw();
        // agent can't tip to itself? it can tip any creator, but not for a user who didn't authorize it
        vm.prank(bob);
        w.deposit(10e18);
        vm.prank(agent);
        vm.expectRevert(Wifly.NotAuthorized.selector);
        w.tipFor(bob, carol, 1e18, POST);
        // revoke
        vm.prank(alice);
        w.revokeAgent();
        vm.prank(agent);
        vm.expectRevert(Wifly.NotAuthorized.selector);
        w.tipFor(alice, carol, 1e18, POST);
        assertEq(w.agentRemaining(alice), 0);
    }

    function test_user_oneTapFromOwnBalance_noCap() public {
        vm.startPrank(alice);
        w.deposit(500e18);
        w.tipFor(alice, bob, 400e18, POST);
        vm.expectRevert(Wifly.InsufficientBalance.selector);
        w.tipFor(alice, bob, 101e18, POST);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ voting
    function test_vote_splitsAndTracksLeader() public {
        uint256 supply = token.totalSupply();
        uint256 ep = w.currentEpoch();
        vm.expectEmit(address(w));
        emit Wifly.Voted(alice, bob, POST, 10e18, ep);
        vm.prank(alice);
        w.vote(POST, bob, 10e18);
        vm.prank(bob);
        w.vote(POST, carol, 10e18); // tie: bob stays leader
        (address leader,, uint256 lv,,) = w.epochs(ep);
        assertEq(leader, bob);
        assertEq(lv, 10e18);
        vm.prank(alice);
        w.vote(POST, carol, 1);
        (leader,,,,) = w.epochs(ep);
        assertEq(leader, carol);
        // votes 20e18 + 1 wei: 10% burned (2e18; the 1 wei vote rounds to 0 burn, 1 pot)
        assertEq(token.totalSupply(), supply - 2e18);
        assertEq(w.epochPot(), 18e18 + 1);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(w.voterVotes(ep, alice, carol), 1);
        assertEq(w.creatorVotes(ep, carol), 10e18 + 1);
        vm.prank(alice);
        vm.expectRevert(Wifly.SelfPayment.selector);
        w.vote(POST, alice, 1);
    }

    function test_epoch_finalizeAndClaim() public {
        // fund the pot via top spot: 90e18 (90% of 100e18)
        vm.prank(carol);
        w.takeTopSpot(POST, FLOOR);
        uint256 ep = w.currentEpoch();
        address dave = makeAddr("dave");
        token.mint(dave, 100e18);
        vm.prank(dave);
        token.approve(address(w), type(uint256).max);

        vm.prank(alice);
        w.vote(POST, bob, 30e18);
        vm.prank(dave);
        w.vote(POST, bob, 10e18);
        vm.prank(bob);
        w.vote(POST, carol, 5e18);

        vm.expectRevert(Wifly.EpochNotOver.selector);
        w.finalizeEpoch(ep, bob);

        vm.warp(w.epochEndsAt(ep));
        vm.expectRevert(abi.encodeWithSelector(Wifly.NotLeader.selector, bob));
        w.finalizeEpoch(ep, carol);

        vm.prank(alice);
        vm.expectRevert(Wifly.NotFinalized.selector);
        w.claimVoterReward(ep);

        vm.expectEmit(address(w));
        emit Wifly.EpochFinalized(ep, bob, 65.25e18, 65.25e18); // epochPot = 90 (top spot) + 90% of 45 votes = 130.5
        w.finalizeEpoch(ep, bob);
        assertEq(w.balances(bob), 65.25e18);
        assertEq(w.epochPot(), 0);
        assertEq(w.totalVoterPools(), 65.25e18);
        vm.expectRevert(Wifly.AlreadyFinalized.selector);
        w.finalizeEpoch(ep, bob);

        assertEq(w.pendingVoterReward(ep, alice), 48.9375e18); // 30/40 of 65.25
        vm.prank(alice);
        w.claimVoterReward(ep);
        vm.prank(dave);
        w.claimVoterReward(ep);
        assertEq(w.balances(alice), 48.9375e18);
        assertEq(w.balances(dave), 16.3125e18);
        assertEq(w.totalVoterPools(), 0);

        vm.prank(alice);
        vm.expectRevert(Wifly.AlreadyClaimed.selector);
        w.claimVoterReward(ep);
        vm.prank(bob); // voted for the loser
        vm.expectRevert(Wifly.NoVotes.selector);
        w.claimVoterReward(ep);
        _assertSolvent();
    }

    function test_epoch_noVotesAndShares() public {
        uint256 ep = w.currentEpoch();
        vm.warp(w.epochEndsAt(ep));
        vm.expectRevert(Wifly.NoVotes.selector);
        w.finalizeEpoch(ep, address(0));
        vm.prank(owner);
        vm.expectRevert(Wifly.SharesTooHigh.selector);
        w.setEpochShares(6000, 4001);
        vm.prank(owner);
        w.setEpochShares(2000, 3000);
        assertEq(w.winnerShareBps(), 2000);
    }

    function test_ownerCannotDrainEpochRewards() public {
        vm.prank(carol);
        w.takeTopSpot(POST, 1000e18); // pot +900e18
        uint256 ep = w.currentEpoch();
        vm.prank(alice);
        w.vote(POST, bob, 10e18); // pot +9e18
        assertEq(w.epochPot(), 909e18);
        assertEq(token.balanceOf(address(w)), 909e18);
        assertEq(w.excessWif(), 0);

        // the owner's only WIF exit is rescue(), which is capped at excess
        vm.startPrank(owner);
        vm.expectRevert(Wifly.ExceedsExcess.selector);
        w.rescue(address(token), owner, 1);
        w.setTreasury(owner); // re-pointing the treasury only redirects future fees
        w.pause();
        w.unpause();
        vm.stopPrank();
        assertEq(w.epochPot(), 909e18);
        assertEq(token.balanceOf(owner), 0);

        vm.warp(w.epochEndsAt(ep));
        w.finalizeEpoch(ep, bob);
        assertEq(w.balances(bob), 454.5e18);
        vm.prank(alice);
        assertEq(w.claimVoterReward(ep), 454.5e18);
        _assertSolvent();
    }

    // ------------------------------------------------------------------ fee split / treasury / fundPot
    function test_splitFee_roundingDustToPot() public {
        // 2% of 349 wei = 6 wei fee: burn 0.6 -> 0, pot 6
        (uint256 p, uint256 b) = w.quoteSplit(6);
        assertEq(p, 6);
        assertEq(b, 0);
        (uint256 fee, uint256 pf, uint256 bf, uint256 net) = w.quoteFee(349);
        assertEq(fee, 6);
        assertEq(pf, 6);
        assertEq(bf, 0);
        assertEq(net, 343);
        uint256 supply = token.totalSupply();
        vm.expectEmit(address(w));
        emit Wifly.FeeSplit(6, 0);
        vm.prank(alice);
        w.tip(bob, 349, POST);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(w.epochPot(), 6);
        assertEq(token.totalSupply(), supply);
        // 1e18 + 9 wei: burn floor(0.1e18 + 0.9) = 0.1e18, pot the rest (0.9e18 + 9)
        (p, b) = w.quoteSplit(1e18 + 9);
        assertEq(b, 0.1e18);
        assertEq(p, 0.9e18 + 9);
        _assertSolvent();
    }

    function test_splitConstants() public view {
        assertEq(w.POT_BPS() + w.BURN_BPS(), w.BPS());
        assertEq(w.POT_BPS(), 9000);
        assertEq(w.BURN_BPS(), 1000);
        assertEq(w.treasury(), treasury);
    }

    function test_unlinkedHandleTip_split() public {
        uint256 supply = token.totalSupply();
        vm.prank(alice);
        w.tipHandle(HANDLE, 100e18, POST);
        assertEq(w.handleEscrow(HANDLE), 98e18);
        assertEq(w.epochPot(), 1.8e18);
        assertEq(supply - token.totalSupply(), 0.2e18);
        assertEq(token.balanceOf(treasury), 0);
        _assertSolvent();
    }

    function test_plusYearly_andRenew_split() public {
        // Plus = a normal subscription to the team wallet (here: treasury) -> 98% credited, 2% split 90/10
        vm.startPrank(treasury);
        w.setTier(0, 1_500e18);
        w.setYearlyPrice(0, 15_000e18);
        vm.stopPrank();
        token.mint(alice, 20_000e18);
        uint256 supply = token.totalSupply();
        vm.startPrank(alice);
        w.subscribePlan(treasury, 0, 1); // fee 300e18
        w.setAutoRenew(treasury, 0, 0, 1_500e18);
        vm.stopPrank();
        assertEq(w.balances(treasury), 14_700e18);
        assertEq(w.epochPot(), 270e18);
        assertEq(supply - token.totalSupply(), 30e18);
        assertEq(token.balanceOf(treasury), 0);
        (, , , uint64 expiry, , ) = w.subStatus(alice, treasury);
        vm.warp(expiry);
        w.renew(alice, treasury); // monthly renewal, fee 30e18
        assertEq(w.balances(treasury), 14_700e18 + 1_470e18);
        assertEq(w.epochPot(), 270e18 + 27e18);
        assertEq(supply - token.totalSupply(), 33e18);
        _assertSolvent();
    }

    function test_pot_feesAfterWeekEndGoToNextWeek() public {
        uint256 ep = w.currentEpoch();
        vm.prank(alice);
        w.vote(POST, bob, 100e18); // pot +90
        assertEq(w.payablePot(), 0); // this week's inflow is held back
        vm.warp(w.epochEndsAt(ep));
        assertEq(w.payablePot(), 90e18);
        vm.prank(alice);
        w.tip(carol, 100e18, POST); // new week: pot +1.8, not payable yet
        assertEq(w.epochPot(), 91.8e18);
        assertEq(w.payablePot(), 90e18);
        w.finalizeEpoch(ep, bob);
        assertEq(w.balances(bob), 45e18);
        assertEq(w.epochPot(), 1.8e18); // rolls into the next week
        vm.prank(alice);
        assertEq(w.claimVoterReward(ep), 45e18);
        _assertSolvent();
    }

    function test_pot_emptyWeekRollsOver() public {
        vm.prank(alice);
        w.fundPot(50e18); // week 0, no votes
        uint256 ep0 = w.currentEpoch();
        vm.warp(w.epochEndsAt(ep0));
        uint256 ep1 = w.currentEpoch();
        vm.prank(alice);
        w.vote(POST, bob, 10e18); // pot +9
        vm.expectRevert(Wifly.NoVotes.selector);
        w.finalizeEpoch(ep0, address(0));
        vm.warp(w.epochEndsAt(ep1));
        w.finalizeEpoch(ep1, bob);
        assertEq(w.balances(bob), 29.5e18); // half of 59
        _assertSolvent();
    }

    function test_feeSplit_appliesToSubsUnlockPay() public {
        vm.prank(bob);
        w.setTier(0, 100e18);
        vm.prank(bob);
        w.setContentPrice(POST, 50e18);
        uint256 supply = token.totalSupply();
        vm.startPrank(alice);
        w.subscribe(bob, 0); // fee 2
        w.unlock(bob, POST); // fee 1
        w.pay(bob, 200e18, POST); // fee 4
        vm.stopPrank();
        assertEq(token.balanceOf(treasury), 0);
        assertEq(w.epochPot(), 6.3e18);
        assertEq(supply - token.totalSupply(), 0.7e18);
        assertEq(w.balances(bob), 343e18);
        _assertSolvent();
    }

    function test_setTreasury() public {
        address t2 = makeAddr("t2");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        w.setTreasury(t2);
        vm.prank(owner);
        vm.expectRevert(Wifly.ZeroAddress.selector);
        w.setTreasury(address(0));
        vm.expectEmit(address(w));
        emit Wifly.TreasurySet(t2);
        vm.prank(owner);
        w.setTreasury(t2);
        assertEq(w.treasury(), t2);
        vm.prank(alice);
        w.tip(bob, 100e18, POST);
        assertEq(token.balanceOf(t2), 0); // Wifly fees never go to the treasury
        assertEq(token.balanceOf(treasury), 0);
    }

    function test_constructor_zeroTreasuryReverts() public {
        address impl = address(new Wifly());
        vm.expectRevert(Wifly.ZeroAddress.selector);
        Proxies.wiflyWith(impl, address(token), true, owner, attester, address(0), FLOOR);
    }

    function test_fundPot() public {
        vm.expectEmit(address(w));
        emit Wifly.PotFunded(alice, 7e18);
        vm.prank(alice);
        w.fundPot(7e18);
        assertEq(w.epochPot(), 7e18);
        assertEq(w.communityPot(), 7e18);
        vm.prank(alice);
        vm.expectRevert(Wifly.ZeroAmount.selector);
        w.fundPot(0);
        // works while paused (so WiflyNames claims never break), spent only via finalizeEpoch
        vm.prank(owner);
        w.pause();
        vm.prank(bob);
        w.fundPot(3e18);
        assertEq(w.epochPot(), 10e18);
        _assertSolvent();
    }

    // ------------------------------------------------------------------ admin
    function test_fee_capAndOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        w.setFeeBps(100);
        vm.prank(owner);
        vm.expectRevert(Wifly.FeeTooHigh.selector);
        w.setFeeBps(501);
        vm.prank(owner);
        w.setFeeBps(0);
        uint256 bobWallet = token.balanceOf(bob);
        vm.prank(alice);
        w.tip(bob, 100e18, POST);
        assertEq(token.balanceOf(bob), bobWallet + 100e18);
        assertEq(w.totalBurned(), 0);
    }

    function test_pause_blocksPaymentsNotWithdrawals() public {
        vm.prank(alice);
        w.tip(bob, 100e18, POST);
        vm.prank(bob);
        w.deposit(50e18);
        vm.prank(alice);
        uint256 id = w.tipHandle(HANDLE, 100e18, POST);
        vm.prank(owner);
        w.pause();

        vm.startPrank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        w.tip(bob, 1e18, POST);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        w.deposit(1e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        w.vote(POST, bob, 1e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        w.takeTopSpot(POST, FLOOR);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        w.pay(bob, 1e18, POST);
        vm.stopPrank();

        vm.prank(bob);
        w.withdraw();
        vm.warp(block.timestamp + 30 days);
        vm.prank(alice);
        w.refundHandleTip(id);
        vm.prank(alice);
        w.withdraw();
        assertEq(w.totalLiabilities(), w.communityPot());
    }

    function test_rescue_onlyExcess() public {
        vm.prank(alice);
        w.deposit(100e18);
        vm.prank(alice);
        token.transfer(address(w), 5e18); // stray transfer
        assertEq(w.excessWif(), 5e18);
        vm.prank(owner);
        vm.expectRevert(Wifly.ExceedsExcess.selector);
        w.rescue(address(token), owner, 6e18);
        vm.prank(owner);
        w.rescue(address(token), owner, 5e18);
        _assertSolvent();
    }

    function test_ownable2Step() public {
        vm.prank(owner);
        w.transferOwnership(alice);
        assertEq(w.owner(), owner);
        vm.prank(alice);
        w.acceptOwnership();
        assertEq(w.owner(), alice);
    }

    function test_deadFallbackBurn() public {
        MockNoBurn nb = new MockNoBurn();
        Wifly w2 = Proxies.wifly(address(nb), false, owner, attester, treasury, FLOOR);
        nb.mint(alice, 100e18);
        vm.startPrank(alice);
        nb.approve(address(w2), type(uint256).max);
        w2.tip(bob, 100e18, POST);
        vm.stopPrank();
        assertEq(nb.balanceOf(w2.DEAD()), 0.2e18);
        assertEq(w2.epochPot(), 1.8e18);
        assertEq(nb.balanceOf(treasury), 0);
    }

    // ------------------------------------------------------------------ fuzz
    function testFuzz_feeMath(uint256 amount, uint16 feeBps) public {
        amount = bound(amount, 1, 1_000_000e18);
        feeBps = uint16(bound(feeBps, 0, 500));
        vm.prank(owner);
        w.setFeeBps(feeBps);
        (uint256 fee, uint256 potPart, uint256 burnPart, uint256 net) = w.quoteFee(amount);
        assertEq(fee + net, amount);
        assertEq(potPart + burnPart, fee);
        assertLe(fee, amount * 500 / 10_000);
        assertEq(burnPart, fee * 1000 / 10_000); // exactly 10% of the fee burned (rounded down)
        assertEq(potPart, fee - fee * 1000 / 10_000); // 90% + dust to the pot

        uint256 supply = token.totalSupply();
        uint256 potBefore = w.communityPot();
        uint256 tBefore = token.balanceOf(treasury);
        uint256 bobWallet = token.balanceOf(bob);
        vm.prank(alice);
        w.tip(bob, amount, POST);
        assertEq(token.balanceOf(bob) - bobWallet, net);
        assertEq(w.balances(bob), 0);
        assertEq(w.communityPot() - potBefore, potPart);
        assertEq(token.balanceOf(treasury) - tBefore, 0);
        assertEq(supply - token.totalSupply(), burnPart);
        _assertSolvent();
    }

    function testFuzz_voteSplit(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000e18);
        uint256 supply = token.totalSupply();
        vm.prank(alice);
        w.vote(POST, bob, amount);
        assertEq(w.epochPot(), amount - amount * 1000 / 10_000);
        assertEq(supply - token.totalSupply(), amount * 1000 / 10_000);
        assertEq(w.totalBurned(), amount * 1000 / 10_000);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(token.balanceOf(address(w)), w.epochPot());
        _assertSolvent();
    }

    function testFuzz_topSpotSplit(uint256 first, uint256 second) public {
        first = bound(first, FLOOR, 100_000e18);
        vm.prank(alice);
        w.takeTopSpot(POST, first);
        vm.warp(block.timestamp + 60);
        uint256 minBid = w.minTopSpotBid();
        assertGe(minBid * 10_000, first * 11_000);
        second = bound(second, minBid, 500_000e18);
        uint256 supply = token.totalSupply();
        vm.prank(bob);
        w.takeTopSpot(POST, second);
        uint256 slice = second - second * 9000 / 10_000;
        assertEq(w.balances(alice), second * 9000 / 10_000);
        assertEq(supply - token.totalSupply(), slice * 1000 / 10_000); // 10% of the 10% slice burned
        _assertSolvent();
    }

    function testFuzz_voterClaimsNeverExceedPool(uint96 a, uint96 b, uint96 c, uint96 potFund) public {
        uint256 va = bound(a, 1, 100_000e18);
        uint256 vb = bound(b, 1, 100_000e18);
        uint256 vc = bound(c, 1, 100_000e18);
        uint256 fund = bound(potFund, FLOOR, 100_000e18);
        vm.prank(carol);
        w.takeTopSpot(POST, fund);
        address dave = makeAddr("dave");
        uint256 ep = w.currentEpoch();
        vm.prank(alice);
        w.vote(POST, dave, va);
        vm.prank(bob);
        w.vote(POST, dave, vb);
        vm.prank(carol);
        w.vote(POST, dave, vc);
        vm.warp(w.epochEndsAt(ep));
        w.finalizeEpoch(ep, dave);
        (,,, uint256 pool,) = w.epochs(ep);
        vm.prank(alice);
        uint256 ra = w.claimVoterReward(ep);
        vm.prank(bob);
        uint256 rb = w.claimVoterReward(ep);
        vm.prank(carol);
        uint256 rc = w.claimVoterReward(ep);
        assertLe(ra + rb + rc, pool);
        assertLe(pool - (ra + rb + rc), 3); // only rounding dust
        _assertSolvent();
    }
}
