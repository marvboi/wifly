// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Wifly} from "../src/Wifly.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {MockWIF} from "./mocks/MockWIF.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {MockPaySwap} from "./mocks/MockPaySwap.sol";
import {Proxies} from "./utils/Proxies.sol";
import {UsdMath} from "../src/UsdMath.sol";

contract WiflyCheckoutTest is Test {
    MockWIF internal token;
    MockUSDG internal usdg;
    Wifly internal w;
    WiflyNames internal n;
    MockPaySwap internal swap;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal team = makeAddr("team");
    address internal alice = makeAddr("alice");

    function setUp() public {
        token = new MockWIF();
        usdg = new MockUSDG();
        w = Proxies.wifly(address(token), true, owner, makeAddr("att"), treasury, 100e18);
        n = Proxies.names(address(token), true, owner, treasury, 200e18, 2_000e18);
        vm.startPrank(owner);
        w.initializeFlat();
        w.initializeV3();
        n.initializeV2(200e18, 2_000e18, 4_000e18, 8_000e18);
        n.initializeV3();
        n.setPot(address(w));
        w.setSwapRouter(address(swap = new MockPaySwap(token)));
        n.setSwapRouter(address(swap));
        w.setUsdg(address(usdg));
        n.setUsdg(address(usdg));
        vm.stopPrank();

        token.mint(address(swap), 10_000_000e18);

        vm.startPrank(team);
        w.setTier(0, 1_500e18);
        w.setYearlyPrice(0, 15_000e18);
        vm.stopPrank();

        usdg.mint(alice, 1_000_000e6);
        token.mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        token.approve(address(w), type(uint256).max);
        token.approve(address(n), type(uint256).max);
        usdg.approve(address(w), type(uint256).max);
        usdg.approve(address(n), type(uint256).max);
        vm.stopPrank();
    }

    function test_initializeV3_usdgAndVoteFloor() public view {
        assertEq(address(w.usdg()), address(usdg));
        assertEq(w.minVoteAmount(), 30e18);
        assertEq(w.usdgPerWif(), UsdMath.USDG_UNIT);
        assertEq(UsdMath.usdgForWif(1_500e18, w.usdgPerWif()), 1_500e6);
    }

    function test_vote_revertsBelowMin() public {
        vm.prank(alice);
        token.approve(address(w), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(Wifly.VoteTooLow.selector, 30e18));
        vm.prank(alice);
        w.vote(keccak256("p"), team, 29e18);
    }

    function test_payPlus_usdg() public {
        uint256 usdgDue = w.quoteUsdgForWif(1_500e18);
        vm.prank(alice);
        w.payPlusUsdg(team, 0, 0, usdgDue);
        (bool active,,,,,) = w.subStatus(alice, team);
        assertTrue(active);
    }

    function test_payClaim_usdg() public {
        uint256 fee = n.claimFeeOf("alice");
        uint256 usdgDue = n.quoteUsdgForWif(fee);
        vm.prank(alice);
        n.payClaimUsdg("alice", alice, usdgDue);
        assertEq(n.ownerOfName("alice"), alice);
    }

    function test_payBoost_wif() public {
        bytes32 post = keccak256("boost-me");
        vm.prank(alice);
        w.takeTopSpot(post, 100e18);
        (address holder,,,) = w.topSpot();
        assertEq(holder, alice);
    }
}