// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Wifly} from "../src/Wifly.sol";
import {WiflyBase} from "./utils/WiflyBase.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Vm} from "forge-std/Vm.sol";

contract WiflyRenewTest is WiflyBase {
    address internal keeper = makeAddr("keeper");
    address internal dave = makeAddr("dave"); // allowance-only user
    uint256 internal constant PRICE = 50e18;

    function setUp() public override {
        super.setUp();
        vm.prank(bob);
        w.setTier(0, PRICE);
        token.mint(dave, 1_000e18);
    }

    function _subAndOptIn(address user, uint256 maxPrice) internal {
        vm.startPrank(user);
        token.approve(address(w), type(uint256).max);
        w.subscribe(bob, 0);
        w.setAutoRenew(bob, 0, 0, maxPrice);
        vm.stopPrank();
    }

    function _expiry(address user) internal view returns (uint64 e) {
        (,, e) = w.isSubscribed(user, bob);
    }

    // ---------------------------------------------------------------- opt-in
    function test_setAutoRenew_storesAndClears() public {
        vm.expectEmit(address(w));
        emit Wifly.AutoRenewSet(alice, bob, 0, 0, PRICE);
        vm.prank(alice);
        w.setAutoRenew(bob, 0, 0, PRICE);
        (uint8 tier,, uint240 maxPrice) = w.autoRenewOf(alice, bob);
        assertEq(tier, 0);
        assertEq(maxPrice, PRICE);
        vm.prank(alice);
        w.setAutoRenew(bob, 0, 0, 0);
        (,, maxPrice) = w.autoRenewOf(alice, bob);
        assertEq(maxPrice, 0);
    }

    function test_setAutoRenew_reverts() public {
        vm.startPrank(alice);
        vm.expectRevert(Wifly.InvalidTier.selector);
        w.setAutoRenew(bob, 3, 0, PRICE);
        vm.expectRevert(Wifly.ZeroAddress.selector);
        w.setAutoRenew(address(0), 0, 0, PRICE);
        vm.expectRevert(Wifly.SelfPayment.selector);
        w.setAutoRenew(alice, 0, 0, PRICE);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- renew paths
    function test_renew_fromDepositOnly() public {
        _subAndOptIn(alice, PRICE);
        vm.prank(alice);
        w.deposit(PRICE);
        vm.prank(alice);
        token.approve(address(w), 0); // no allowance at all: deposit must be used
        uint64 e = _expiry(alice);
        uint256 walletBefore = token.balanceOf(alice);
        vm.warp(e + 1 hours);
        vm.prank(keeper);
        w.renew(alice, bob);
        assertEq(w.balances(alice), 0);
        assertEq(token.balanceOf(alice), walletBefore);
        assertEq(_expiry(alice), e + 30 days, "grace renewal keeps the schedule");
        assertEq(w.balances(bob), 2 * (PRICE - PRICE * 200 / 10_000));
        _assertSolvent();
    }

    function test_renew_fromAllowanceOnly() public {
        vm.startPrank(dave);
        token.approve(address(w), PRICE * 3); // capped, 3 months
        w.subscribe(bob, 0);
        w.setAutoRenew(bob, 0, 0, PRICE);
        vm.stopPrank();
        assertEq(w.balances(dave), 0);
        uint64 e = _expiry(dave);
        vm.warp(e);
        vm.prank(keeper);
        w.renew(dave, bob);
        assertEq(token.balanceOf(dave), 1_000e18 - 2 * PRICE);
        assertEq(token.allowance(dave, address(w)), PRICE);
        assertEq(_expiry(dave), e + 30 days);
        _assertSolvent();
    }

    function test_renew_partialDepositUsesWalletForFullPrice() public {
        _subAndOptIn(alice, PRICE);
        vm.prank(alice);
        w.deposit(PRICE - 1);
        uint256 walletBefore = token.balanceOf(alice);
        vm.warp(_expiry(alice));
        w.renew(alice, bob);
        assertEq(w.balances(alice), PRICE - 1, "deposit untouched");
        assertEq(token.balanceOf(alice), walletBefore - PRICE);
    }

    function test_renew_neitherCovers_revertsCleanly() public {
        vm.startPrank(dave);
        token.approve(address(w), PRICE); // only the first month
        w.subscribe(bob, 0);
        w.setAutoRenew(bob, 0, 0, PRICE);
        vm.stopPrank();
        uint64 e = _expiry(dave);
        vm.warp(e + 1);
        vm.recordLogs();
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(w), 0, PRICE));
        w.renew(dave, bob);
        assertEq(vm.getRecordedLogs().length, 0, "no events");
        assertEq(_expiry(dave), e);
    }

    function test_renew_afterGraceStartsFresh() public {
        _subAndOptIn(alice, PRICE);
        uint64 e = _expiry(alice);
        uint256 t = e + w.gracePeriod() + 3 days;
        vm.warp(t);
        w.renew(alice, bob);
        assertEq(_expiry(alice), t + 30 days);
    }

    // ---------------------------------------------------------------- guards
    function test_renew_noChargeBeforeExpiry() public {
        _subAndOptIn(alice, PRICE);
        vm.warp(_expiry(alice) - 1);
        vm.expectRevert(Wifly.NotRenewable.selector);
        w.renew(alice, bob);
    }

    function test_renew_noDoubleChargeSamePeriod() public {
        _subAndOptIn(alice, PRICE);
        vm.warp(_expiry(alice) + 1);
        w.renew(alice, bob);
        uint256 bal = token.balanceOf(alice);
        vm.expectRevert(Wifly.NotRenewable.selector);
        w.renew(alice, bob);
        vm.warp(block.timestamp + 29 days);
        vm.expectRevert(Wifly.NotRenewable.selector);
        w.renew(alice, bob);
        assertEq(token.balanceOf(alice), bal);
    }

    function test_renew_optedOutNeverCharges() public {
        vm.startPrank(alice);
        w.subscribe(bob, 0);
        vm.stopPrank();
        vm.warp(_expiry(alice) + 1);
        vm.expectRevert(Wifly.AutoRenewOff.selector);
        w.renew(alice, bob);
    }

    function test_renew_optOutStopsImmediately() public {
        _subAndOptIn(alice, PRICE);
        vm.warp(_expiry(alice) + 1);
        vm.prank(alice);
        w.setAutoRenew(bob, 0, 0, 0);
        vm.expectRevert(Wifly.AutoRenewOff.selector);
        w.renew(alice, bob);
    }

    function test_renew_priceIncreaseStops() public {
        _subAndOptIn(alice, PRICE);
        vm.prank(bob);
        w.setTier(0, PRICE + 1);
        vm.warp(_expiry(alice) + 1);
        uint256 bal = token.balanceOf(alice);
        vm.expectRevert(abi.encodeWithSelector(Wifly.PriceAboveMax.selector, PRICE + 1, PRICE));
        w.renew(alice, bob);
        assertEq(token.balanceOf(alice), bal);
    }

    function test_renew_priceDecreaseChargesLower() public {
        _subAndOptIn(alice, PRICE);
        vm.prank(bob);
        w.setTier(0, PRICE / 2);
        vm.warp(_expiry(alice) + 1);
        uint256 bal = token.balanceOf(alice);
        w.renew(alice, bob);
        assertEq(bal - token.balanceOf(alice), PRICE / 2);
    }

    function test_renew_tierDisabledReverts() public {
        _subAndOptIn(alice, PRICE);
        vm.prank(bob);
        w.setTier(0, 0);
        vm.warp(_expiry(alice) + 1);
        vm.expectRevert(Wifly.TierDisabled.selector);
        w.renew(alice, bob);
    }

    function test_renew_neverSubscribedReverts() public {
        vm.prank(alice);
        w.setAutoRenew(bob, 0, 0, PRICE);
        vm.expectRevert(Wifly.NotRenewable.selector);
        w.renew(alice, bob);
    }

    function test_renew_pausedReverts() public {
        _subAndOptIn(alice, PRICE);
        vm.prank(owner);
        w.pause();
        vm.warp(_expiry(alice) + 1);
        vm.expectRevert();
        w.renew(alice, bob);
    }

    // ---------------------------------------------------------------- grace
    function test_subStatus_grace() public {
        vm.prank(alice);
        w.subscribe(bob, 0);
        uint64 e = _expiry(alice);
        vm.warp(e + 1);
        (bool active, bool access,, uint64 expiry, uint256 graceEnds,) = w.subStatus(alice, bob);
        assertFalse(active);
        assertTrue(access);
        assertEq(expiry, e);
        assertEq(graceEnds, e + 5 days);
        vm.warp(e + 5 days);
        (, access,,,,) = w.subStatus(alice, bob);
        assertFalse(access);
    }

    function test_manualSubscribeInGraceKeepsSchedule() public {
        vm.startPrank(alice);
        w.subscribe(bob, 0);
        uint64 e = _expiry(alice);
        vm.warp(e + 2 days);
        w.subscribe(bob, 0);
        vm.stopPrank();
        assertEq(_expiry(alice), e + 30 days);
    }

    function test_setGracePeriod() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        w.setGracePeriod(2 days);
        vm.startPrank(owner);
        vm.expectRevert(Wifly.BadGrace.selector);
        w.setGracePeriod(1 days - 1);
        vm.expectRevert(Wifly.BadGrace.selector);
        w.setGracePeriod(30 days + 1);
        w.setGracePeriod(7 days);
        vm.stopPrank();
        assertEq(w.gracePeriod(), 7 days);
    }

    // ---------------------------------------------------------------- fuzz
    /// @dev Over many keeper calls at random times, total charged == price * renewals, and renewals never
    ///      exceed the number of 30-day periods that actually started.
    function testFuzz_renew_neverOverOrDoubleCharges(uint256 seed, uint8 calls) public {
        _subAndOptIn(alice, PRICE);
        uint256 start = token.balanceOf(alice);
        uint256 renewals;
        uint256 n = bound(calls, 1, 40);
        for (uint256 i; i < n; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(block.timestamp + (seed % 20 days));
            uint64 before = _expiry(alice);
            bool due = block.timestamp >= before;
            try w.renew(alice, bob) {
                assertTrue(due, "charged before expiry");
                ++renewals;
                assertGe(_expiry(alice), before + 30 days);
                assertGt(_expiry(alice), block.timestamp);
            } catch {
                assertFalse(due, "due renewal failed");
            }
        }
        assertEq(start - token.balanceOf(alice), renewals * PRICE);
        // every renewal buys a disjoint 30-day window ending after the call
        assertLe(renewals, (block.timestamp - START) / 30 days + 1);
    }

    function testFuzz_renew_maxPriceRespected(uint256 maxPrice, uint256 newPrice) public {
        maxPrice = bound(maxPrice, 1, 1e23);
        newPrice = bound(newPrice, 1, 1e23);
        _subAndOptIn(alice, maxPrice);
        vm.prank(bob);
        w.setTier(0, newPrice);
        vm.warp(_expiry(alice));
        uint256 bal = token.balanceOf(alice);
        try w.renew(alice, bob) {
            assertLe(newPrice, maxPrice);
            assertEq(bal - token.balanceOf(alice), newPrice);
        } catch {
            assertGt(newPrice, maxPrice);
            assertEq(token.balanceOf(alice), bal);
        }
    }

    // ---------------------------------------------------------------- monthly / yearly plans
    uint256 internal constant PLUS_MONTH = 1_500e18;
    uint256 internal constant PLUS_YEAR = 15_000e18;

    function _plusPrices() internal {
        vm.startPrank(bob);
        w.setTier(1, PLUS_MONTH);
        w.setYearlyPrice(1, PLUS_YEAR);
        vm.stopPrank();
    }

    function test_yearly_subscribeChargesYearlyPriceFor365Days() public {
        _plusPrices();
        uint256 bal = token.balanceOf(alice);
        vm.expectEmit(address(w));
        emit Wifly.Subscribed(
            alice, bob, 1, uint64(block.timestamp + 365 days), PLUS_YEAR, PLUS_YEAR * w.feeBps() / 10_000, alice, 1
        );
        uint8 yearly = w.YEARLY();
        vm.prank(alice);
        w.subscribePlan(bob, 1, yearly);
        assertEq(bal - token.balanceOf(alice), PLUS_YEAR);
        assertEq(_expiry(alice), block.timestamp + 365 days);
        (,,,,, uint8 plan) = w.subStatus(alice, bob);
        assertEq(plan, 1);
        assertEq(w.yearlyPrices(bob)[1], PLUS_YEAR);
        assertEq(w.tierPrices(bob)[1], PLUS_MONTH);
    }

    function test_yearly_disabledByDefault_andInvalidPlan() public {
        vm.startPrank(alice);
        vm.expectRevert(Wifly.TierDisabled.selector);
        w.subscribePlan(bob, 0, 1); // monthly set, yearly not
        vm.expectRevert(Wifly.InvalidPlan.selector);
        w.subscribePlan(bob, 0, 2);
        vm.expectRevert(Wifly.InvalidPlan.selector);
        w.setAutoRenew(bob, 0, 2, PRICE);
        vm.stopPrank();
    }

    function test_yearly_fromDeposit() public {
        _plusPrices();
        vm.prank(alice);
        w.deposit(PLUS_YEAR);
        vm.prank(alice);
        w.subscribeForPlan(alice, bob, 1, 1);
        assertEq(w.balances(alice), 0);
        assertEq(_expiry(alice), block.timestamp + 365 days);
    }

    function test_monthlyThenYearly_sameTierExtendsFromExpiry() public {
        _plusPrices();
        vm.startPrank(alice);
        w.subscribePlan(bob, 1, 0);
        uint64 e = _expiry(alice);
        w.subscribePlan(bob, 1, 1);
        vm.stopPrank();
        assertEq(_expiry(alice), e + 365 days);
    }

    function test_autoRenew_yearlyRenewsSamePlanAtYearlyPrice() public {
        _plusPrices();
        vm.startPrank(alice);
        w.subscribePlan(bob, 1, 1);
        w.setAutoRenew(bob, 1, 1, PLUS_YEAR);
        vm.stopPrank();
        uint64 e = _expiry(alice);
        vm.prank(keeper);
        vm.expectRevert(Wifly.NotRenewable.selector);
        w.renew(alice, bob); // not before expiry
        vm.warp(e + 1 days);
        uint256 bal = token.balanceOf(alice);
        vm.prank(keeper);
        w.renew(alice, bob);
        assertEq(bal - token.balanceOf(alice), PLUS_YEAR);
        assertEq(_expiry(alice), e + 365 days);
        vm.prank(keeper);
        vm.expectRevert(Wifly.NotRenewable.selector);
        w.renew(alice, bob); // no double charge
    }

    function test_autoRenew_yearlyPriceRaisedStops() public {
        _plusPrices();
        vm.startPrank(alice);
        w.subscribePlan(bob, 1, 1);
        w.setAutoRenew(bob, 1, 1, PLUS_YEAR);
        vm.stopPrank();
        vm.prank(bob);
        w.setYearlyPrice(1, PLUS_YEAR + 1);
        vm.warp(_expiry(alice));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Wifly.PriceAboveMax.selector, PLUS_YEAR + 1, PLUS_YEAR));
        w.renew(alice, bob);
    }

    function test_autoRenew_monthlyOptInIgnoresYearlyPrice() public {
        _plusPrices();
        vm.startPrank(alice);
        w.subscribePlan(bob, 1, 0);
        w.setAutoRenew(bob, 1, 0, PLUS_MONTH);
        vm.stopPrank();
        uint64 e = _expiry(alice);
        vm.warp(e);
        uint256 bal = token.balanceOf(alice);
        vm.prank(keeper);
        w.renew(alice, bob);
        assertEq(bal - token.balanceOf(alice), PLUS_MONTH);
        assertEq(_expiry(alice), e + 30 days);
    }
}
