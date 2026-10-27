// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Wifly} from "../src/Wifly.sol";
import {Proxies} from "./utils/Proxies.sol";

/// @notice Runs against the real $WIF on Robinhood Chain (4663). Skipped unless RH_RPC_URL is set:
///         RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract Fork
contract WiflyForkTest is Test {
    address constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;
    IERC20 constant token = IERC20(WIF);
    Wifly w;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("RH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        assertEq(block.chainid, 4663);
        w = Proxies.wifly(WIF, true, makeAddr("owner"), makeAddr("attester"), makeAddr("treasury"), 100e18);
        deal(WIF, alice, 10_000e18, true); // adjusts totalSupply too
        vm.prank(alice);
        token.approve(address(w), type(uint256).max);
    }

    function test_fork_realWifBurnAndFlows() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        uint256 supply = token.totalSupply();
        uint256 bobWallet = token.balanceOf(bob);
        vm.prank(alice);
        w.tip(bob, 1_000e18, bytes32("p"));
        assertEq(token.totalSupply(), supply - 2e18, "burn() must reduce real supply (10% of the 2% fee)");
        assertEq(token.balanceOf(bob), bobWallet + 980e18, "tip net goes straight to bob's wallet");
        assertEq(w.balances(bob), 0);

        vm.prank(alice);
        w.takeTopSpot(bytes32("p"), 100e18);
        vm.prank(alice);
        w.vote(bytes32("p"), bob, 50e18);
        assertEq(token.totalSupply(), supply - 2e18 - 10e18 - 5e18);

        assertEq(token.balanceOf(bob), bobWallet + 980e18);
        assertGe(token.balanceOf(address(w)), w.totalLiabilities());
    }
}
