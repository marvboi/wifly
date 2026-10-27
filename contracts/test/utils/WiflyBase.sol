// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Wifly} from "../../src/Wifly.sol";
import {MockWIF} from "../mocks/MockWIF.sol";
import {Proxies} from "./Proxies.sol";

abstract contract WiflyBase is Test {
    Wifly internal w;
    MockWIF internal token;

    address internal owner = makeAddr("owner");
    uint256 internal attesterPk = 0xA11CE;
    address internal attester;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal agent = makeAddr("agent");
    address internal treasury = makeAddr("treasury");

    uint256 internal constant FLOOR = 100e18;
    uint256 internal constant START = 1_800_000_000; // a fixed, realistic timestamp

    function setUp() public virtual {
        vm.warp(START);
        attester = vm.addr(attesterPk);
        token = new MockWIF();
        w = Proxies.wifly(address(token), true, owner, attester, treasury, FLOOR);
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < users.length; ++i) {
            token.mint(users[i], 1_000_000e18);
            vm.prank(users[i]);
            token.approve(address(w), type(uint256).max);
        }
    }

    function _sign(bytes32 handleHash, address account, uint256 deadline) internal view returns (bytes memory) {
        bytes32 digest = w.linkDigest(handleHash, account, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _assertSolvent() internal view {
        assertGe(token.balanceOf(address(w)), w.totalLiabilities(), "insolvent");
    }
}
