// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WiflyBadges} from "../src/WiflyBadges.sol";
import {MockWIF, MockNoBurn} from "./mocks/MockWIF.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Proxies} from "./utils/Proxies.sol";

/// @dev A contract wallet with no ERC1155Receiver hook (e.g. a minimal smart account).
contract BareWallet {
    function call(address to, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call(data);
        require(ok, "call failed");
        return ret;
    }
}

contract WiflyBadgesTest is Test {
    WiflyBadges internal b;
    MockWIF internal token;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new MockWIF();
        uint256[] memory t = new uint256[](3);
        t[0] = 100e18;
        t[1] = 1_000e18;
        t[2] = 10_000e18;
        b = Proxies.badges(address(token), true, owner, "https://wifly.example/badges/{id}.json", t);
        token.mint(alice, 1_000_000e18);
        token.mint(bob, 1_000_000e18);
        vm.prank(alice);
        token.approve(address(b), type(uint256).max);
        vm.prank(bob);
        token.approve(address(b), type(uint256).max);
    }

    function test_burn_awardsTiersCumulatively() public {
        uint256 supply = token.totalSupply();
        vm.prank(alice);
        b.burn(99e18);
        assertEq(b.balanceOf(alice, 0), 0);
        vm.prank(alice);
        b.burn(1e18);
        assertEq(b.balanceOf(alice, 0), 1);
        vm.prank(alice);
        b.burn(9_900e18); // jumps two tiers at once
        assertEq(b.balanceOf(alice, 1), 1);
        assertEq(b.balanceOf(alice, 2), 1);
        assertEq(b.levelsEarned(alice), 3);
        assertEq(b.burnedBy(alice), 10_000e18);
        assertEq(token.totalSupply(), supply - 10_000e18);
        assertEq(token.balanceOf(address(b)), 0);
        vm.prank(alice);
        b.burn(1e18); // no duplicates
        assertEq(b.balanceOf(alice, 2), 1);
    }

    function test_toNextBadge() public {
        (uint256 id, uint256 rem) = b.toNextBadge(alice);
        assertEq(id, 0);
        assertEq(rem, 100e18);
        vm.prank(alice);
        b.burn(150e18);
        (id, rem) = b.toNextBadge(alice);
        assertEq(id, 1);
        assertEq(rem, 850e18);
    }

    function test_soulbound() public {
        vm.prank(alice);
        b.burn(100e18);
        vm.startPrank(alice);
        vm.expectRevert(WiflyBadges.Soulbound.selector);
        b.safeTransferFrom(alice, bob, 0, 1, "");
        uint256[] memory ids = new uint256[](1);
        uint256[] memory vals = new uint256[](1);
        vals[0] = 1;
        vm.expectRevert(WiflyBadges.Soulbound.selector);
        b.safeBatchTransferFrom(alice, bob, ids, vals, "");
        vm.expectRevert(WiflyBadges.Soulbound.selector);
        b.setApprovalForAll(bob, true);
        vm.stopPrank();
        assertEq(b.balanceOf(alice, 0), 1);
    }

    function test_newLevelThenClaim() public {
        vm.prank(alice);
        b.burn(50_000e18);
        assertEq(b.levelsEarned(alice), 3);
        vm.prank(owner);
        b.addLevel(50_000e18);
        assertEq(b.balanceOf(alice, 3), 0);
        vm.prank(bob); // anyone can trigger the award
        assertEq(b.claim(alice), 1);
        assertEq(b.balanceOf(alice, 3), 1);
        assertEq(b.claim(alice), 0);
    }

    function test_addLevel_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        b.addLevel(1e30);
        vm.startPrank(owner);
        vm.expectRevert(WiflyBadges.BadThreshold.selector);
        b.addLevel(10_000e18); // not increasing
        for (uint256 i = 4; i <= 32; ++i) {
            b.addLevel(i * 1e22);
        }
        vm.expectRevert(WiflyBadges.TooManyLevels.selector);
        b.addLevel(1e30);
        vm.stopPrank();
    }

    function test_burn_zeroAndAllowance() public {
        vm.prank(alice);
        vm.expectRevert(WiflyBadges.ZeroAmount.selector);
        b.burn(0);
        address dave = makeAddr("dave");
        token.mint(dave, 1e18);
        vm.prank(dave);
        vm.expectRevert(); // no allowance
        b.burn(1e18);
    }

    function test_smartWalletWithoutReceiverCanEarn() public {
        BareWallet wallet = new BareWallet();
        token.mint(address(wallet), 1_000e18);
        wallet.call(address(token), abi.encodeCall(token.approve, (address(b), type(uint256).max)));
        wallet.call(address(b), abi.encodeCall(b.burn, (100e18)));
        assertEq(b.balanceOf(address(wallet), 0), 1);
    }

    function test_noBurnTokenSendsToDead() public {
        MockNoBurn nb = new MockNoBurn();
        uint256[] memory t = new uint256[](1);
        t[0] = 1e18;
        WiflyBadges b2 = Proxies.badges(address(nb), false, owner, "", t);
        nb.mint(alice, 10e18);
        vm.startPrank(alice);
        nb.approve(address(b2), type(uint256).max);
        b2.burn(2e18);
        vm.stopPrank();
        assertEq(nb.balanceOf(b2.DEAD()), 2e18);
        assertEq(b2.balanceOf(alice, 0), 1);
    }

    function testFuzz_badgesMatchThresholds(uint256[5] memory amounts) public {
        uint256 total;
        for (uint256 i; i < 5; ++i) {
            uint256 a = bound(amounts[i], 1, 5_000e18);
            total += a;
            vm.prank(alice);
            b.burn(a);
        }
        uint256[] memory t = b.allThresholds();
        for (uint256 i; i < t.length; ++i) {
            assertEq(b.balanceOf(alice, i), total >= t[i] ? 1 : 0);
        }
        assertEq(b.burnedBy(alice), total);
    }
}
