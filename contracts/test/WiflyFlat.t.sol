// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Wifly} from "../src/Wifly.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {MockWIF} from "./mocks/MockWIF.sol";
import {Proxies} from "./utils/Proxies.sol";

contract WiflyFlatTest is Test {
    MockWIF internal token;
    Wifly internal w;
    WiflyNames internal n;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new MockWIF();
        w = Proxies.wifly(address(token), true, owner, makeAddr("att"), treasury, 100e18);
        n = Proxies.names(address(token), true, owner, treasury, 200e18, 2_000e18);
        vm.prank(owner);
        n.initializeV2(200e18, 2_000e18, 4_000e18, 8_000e18);
        token.mint(alice, 1_000_000e18);
        token.mint(bob, 1_000_000e18);
        vm.prank(alice);
        token.approve(address(w), type(uint256).max);
        vm.prank(alice);
        token.approve(address(n), type(uint256).max);
    }

    function test_initializeFlat_split() public {
        vm.prank(owner);
        w.initializeFlat();
        assertTrue(w.feeSplitSet());
        assertEq(w.feeTreasuryBps(), 2_000);
        assertEq(w.feeBurnBps(), 1_000);
        uint256 supply0 = token.totalSupply();
        uint256 pot0 = w.epochPot();
        vm.prank(alice);
        w.tip(bob, 100e18, keccak256("p"));
        uint256 fee = 2e18;
        uint256 burn = (fee * 1_000) / 10_000;
        uint256 treas = (fee * 2_000) / 10_000;
        uint256 pot = fee - burn - treas;
        assertEq(supply0 - token.totalSupply(), burn);
        assertEq(w.epochPot() - pot0, pot);
        assertEq(w.balances(treasury), treas);
    }

    function test_names_tierFees_v2() public {
        assertEq(n.claimFeeOf("marvellous"), 200e18);
        assertEq(n.claimFeeOf("four"), 2_000e18);
        assertEq(n.claimFeeOf("thr"), 4_000e18);
        assertTrue(n.isValidName("ab"));
        assertEq(n.claimFeeOf("ab"), 8_000e18);
        vm.prank(owner);
        n.setTierFees(200e18, 2_000e18, 4_000e18, 2_000e18);
        assertEq(n.claimFeeOf("ab"), 2_000e18);
    }

    function test_plus_fee_fully_burned() public view {
        (uint256 fee, uint256 burn, uint256 net) = w.quotePlusFee(3_000e18);
        assertEq(fee, 60e18);
        assertEq(burn, 60e18);
        assertEq(net, 2_940e18);
    }

    function test_setFeeShares_caps() public {
        vm.startPrank(owner);
        vm.expectRevert(Wifly.BadShares.selector);
        w.setFeeShares(3_100, 500);
        vm.expectRevert(Wifly.BadShares.selector);
        w.setFeeShares(1_000, 400);
        w.setFeeShares(2_000, 5_000);
        assertEq(w.feeTreasuryBps(), 2_000);
        assertEq(w.feeBurnBps(), 5_000);
        vm.stopPrank();
    }
}