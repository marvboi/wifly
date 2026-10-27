// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {MockWIF} from "./mocks/MockWIF.sol";
import {MockNameRenderer} from "./mocks/MockNameRenderer.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Proxies} from "./utils/Proxies.sol";

contract WiflyNamesThemeTest is Test {
    WiflyNames internal n;
    MockWIF internal token;
    MockNameRenderer internal r;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        token = new MockWIF();
        n = Proxies.names(address(token), true, owner, treasury, 100e18, 1_000e18);
        r = new MockNameRenderer();
        vm.prank(owner);
        n.setRenderer(address(r));
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            token.mint(users[i], 1_000_000e18);
            vm.prank(users[i]);
            token.approve(address(n), type(uint256).max);
        }
    }

    function _claim(address who, string memory name) internal returns (uint256 id) {
        vm.prank(who);
        id = n.claim(name);
    }

    function _uri(uint256 id, string memory name, bool rare, uint8 t) internal pure returns (string memory) {
        return string.concat(
            "mock:", Strings.toHexString(id), ":", name, ":", rare ? "1" : "0", ":0:", Strings.toString(uint256(t))
        );
    }

    function test_theme_defaultsToZero() public {
        uint256 id = _claim(alice, "marv");
        assertEq(n.theme(id), 0);
        assertEq(n.MAX_THEME(), 2);
        assertEq(n.tokenURI(id), _uri(id, "marv", true, 0));
    }

    function test_setTheme_ownerSets_andEmits() public {
        uint256 id = _claim(alice, "marvin");
        for (uint8 t = 0; t <= 2; ++t) {
            vm.expectEmit(address(n));
            emit WiflyNames.ThemeSet(id, t);
            vm.expectEmit(address(n));
            emit WiflyNames.MetadataUpdate(id);
            vm.prank(alice);
            n.setTheme(id, t);
            assertEq(n.theme(id), t);
            assertEq(n.tokenURI(id), _uri(id, "marvin", false, t));
        }
    }

    function test_setTheme_nonOwnerReverts() public {
        uint256 id = _claim(alice, "marv");
        vm.prank(bob);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.setTheme(id, 1);
        // contract owner can't either
        vm.prank(owner);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.setTheme(id, 1);
        // nor on an unminted id
        vm.prank(alice);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.setTheme(uint256(keccak256("nobody")), 1);
    }

    function testFuzz_setTheme_outOfRangeReverts(uint8 t) public {
        t = uint8(bound(t, 3, 255));
        uint256 id = _claim(alice, "marv");
        vm.prank(alice);
        vm.expectRevert(WiflyNames.BadTheme.selector);
        n.setTheme(id, t);
        assertEq(n.theme(id), 0);
    }

    function test_theme_persistsAfterTransfer() public {
        uint256 id = _claim(alice, "marv");
        vm.prank(alice);
        n.setTheme(id, 2);
        vm.prank(alice);
        n.transferFrom(alice, bob, id);
        assertEq(n.theme(id), 2);
        assertEq(n.tokenURI(id), _uri(id, "marv", true, 2));
        // new owner can change it, old owner can't
        vm.prank(alice);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.setTheme(id, 1);
        vm.prank(bob);
        n.setTheme(id, 1);
        assertEq(n.theme(id), 1);
    }

    function test_theme_persistsAfterMarketplaceBuy() public {
        uint256 id = _claim(alice, "marv");
        vm.startPrank(alice);
        n.setTheme(id, 1);
        n.list(id, 500e18);
        vm.stopPrank();
        uint256 vBefore = n.recordVersion(id);
        vm.prank(carol);
        n.buy(id, 500e18);
        assertEq(n.ownerOf(id), carol);
        assertEq(n.recordVersion(id), vBefore + 1); // records were cleared...
        assertEq(n.theme(id), 1); // ...but the theme was kept
        assertEq(n.tokenURI(id), _uri(id, "marv", true, 1));
    }

    function test_theme_viaMulticall_claimThenTheme() public {
        uint256 id = uint256(keccak256("newbie"));
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(WiflyNames.claim, ("newbie"));
        calls[1] = abi.encodeCall(WiflyNames.setTheme, (id, uint8(2)));
        vm.prank(alice);
        n.multicall(calls);
        assertEq(n.ownerOf(id), alice);
        assertEq(n.theme(id), 2);
        // multicall keeps msg.sender: bob can't batch onto alice's name
        bytes[] memory bad = new bytes[](1);
        bad[0] = abi.encodeCall(WiflyNames.setTheme, (id, uint8(1)));
        vm.prank(bob);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.multicall(bad);
    }

    function test_tokenURI_passesReservedAndTheme() public {
        vm.prank(owner);
        uint256 id = n.reserve("wifly", bob);
        vm.prank(bob);
        n.setTheme(id, 2);
        assertEq(
            n.tokenURI(id), string.concat("mock:", Strings.toHexString(id), ":wifly:0:1:2")
        );
    }
}
