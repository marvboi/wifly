// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Wifly} from "../src/Wifly.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {WiflyPayments} from "../src/WiflyPayments.sol";
import {MockWIF} from "./mocks/MockWIF.sol";
import {MockPaySwap} from "./mocks/MockPaySwap.sol";
import {Proxies} from "./utils/Proxies.sol";

contract WiflyPaymentsTest is Test {
    MockWIF internal token;
    MockWIF internal usdg;
    Wifly internal w;
    WiflyNames internal n;
    WiflyPayments internal pay;
    MockPaySwap internal swap;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal team = makeAddr("team");
    address internal alice = makeAddr("alice");

    function setUp() public {
        token = new MockWIF();
        usdg = new MockWIF();
        w = Proxies.wifly(address(token), true, owner, makeAddr("att"), treasury, 100e18);
        n = Proxies.names(address(token), true, owner, treasury, 200e18, 2_000e18);
        vm.prank(owner);
        n.initializeV2(200e18, 2_000e18, 4_000e18, 8_000e18);
        vm.prank(owner);
        n.setPot(address(w));

        WiflyPayments impl = new WiflyPayments();
        bytes memory init = abi.encodeCall(
            WiflyPayments.initialize, (address(w), address(n), address(token), true, team, treasury, owner)
        );
        pay = WiflyPayments(payable(address(new ERC1967Proxy(address(impl), init))));
        swap = new MockPaySwap(token);
        token.mint(address(swap), 10_000_000e18);
        usdg.mint(alice, 1_000_000e18);

        vm.startPrank(owner);
        n.setPaymentRouter(address(pay));
        pay.setSwapRouter(address(swap));
        pay.setUsdg(address(usdg));
        vm.stopPrank();

        vm.startPrank(team);
        w.setTier(0, 1_500e18);
        w.setYearlyPrice(0, 15_000e18);
        vm.stopPrank();

        token.mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        token.approve(address(pay), type(uint256).max);
        usdg.approve(address(pay), type(uint256).max);
        vm.stopPrank();
    }

    function test_payPlus_wif() public {
        vm.prank(alice);
        pay.payPlusWif(0);
        (bool active,,,,,) = w.subStatus(alice, team);
        assertTrue(active);
    }

    function test_payName_wif() public {
        vm.prank(alice);
        pay.payNameWif("flatname", alice);
        assertEq(n.ownerOfName("flatname"), alice);
    }

    function test_payName_usdg() public {
        uint256 fee = n.claimFeeOf("alice");
        vm.prank(alice);
        pay.payNameUsdg("alice", alice, fee);
        assertEq(n.ownerOfName("alice"), alice);
    }

    function test_payBoost_wif() public {
        bytes32 post = keccak256("boost-me");
        vm.prank(alice);
        pay.payBoostWif(post, 100e18);
        (address holder,,,) = w.topSpot();
        assertEq(holder, alice);
    }
}