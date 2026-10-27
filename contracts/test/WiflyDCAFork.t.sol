// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WiflyDCA} from "../src/WiflyDCA.sol";
import {IV4Quoter, QuoteExactSingleParams} from "../src/interfaces/IUniswapV4Minimal.sol";
import {Proxies} from "./utils/Proxies.sol";

/// @notice Real ETH -> WIF buys through the live Uniswap v4 pool (Universal Router 2.1.1) on a Robinhood Chain fork.
///         Skipped unless RH_RPC_URL is set:
///         RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract WiflyDCAFork -vv
contract WiflyDCAForkTest is Test {
    address constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;
    address constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address constant HOOKS = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    WiflyDCA dca;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("RH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        assertEq(block.chainid, 4663);
        dca = Proxies.dca(owner, ROUTER, QUOTER, WIF, HOOKS, 0, 200);
        vm.prank(owner);
        dca.setKeeper(keeper, true);
        vm.deal(alice, 10 ether);
    }

    function _offchainQuote(uint128 amountIn) internal returns (uint256 out) {
        (out,) = IV4Quoter(QUOTER)
            .quoteExactInputSingle(
                QuoteExactSingleParams({poolKey: dca.poolKey(), zeroForOne: true, exactAmount: amountIn, hookData: ""})
            );
    }

    function test_fork_realDcaBuys() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        // 0.001 ETH every hour, floor 500k WIF/ETH (well under the live ~1.87M), 1% slippage cap
        WiflyDCA.PlanParams memory p = WiflyDCA.PlanParams({
            amountPerBuy: 0.001 ether,
            interval: 1 hours,
            maxBuys: 0,
            minWifPerEth: 500_000e18,
            maxSlippageBps: 100,
            keeperTip: 0
        });
        vm.prank(alice);
        uint256 id = dca.createPlan{value: 0.01 ether}(p, 0);

        IERC20 wif = IERC20(WIF);
        for (uint256 i; i < 2; ++i) {
            uint256 q = _offchainQuote(0.001 ether);
            uint256 min = q * 99 / 100;
            uint256 before = wif.balanceOf(alice);
            uint256 g = gasleft();
            vm.prank(keeper);
            uint256 got = dca.execute(id, min);
            uint256 used = g - gasleft();
            assertEq(wif.balanceOf(alice) - before, got, "WIF straight to owner");
            assertGe(got, min);
            assertEq(got, q, "filled at the quote");
            assertEq(wif.balanceOf(address(dca)), 0, "DCA never holds WIF");
            assertEq(address(dca).balance, dca.totalDeposits());
            console2.log("buy", i + 1);
            console2.log("  quote WIF wei", q);
            console2.log("  got   WIF wei", got);
            console2.log("  gas (execute)", used);
            vm.warp(block.timestamp + 1 hours);
        }
        assertEq(dca.getPlan(id).balance, 0.008 ether);

        // a min above what the pool can give: the swap reverts in the router and nothing moves
        uint256 q2 = _offchainQuote(0.001 ether);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.SwapFailed));
        dca.execute(id, q2 + 1);
        assertEq(dca.getPlan(id).balance, 0.008 ether);

        // a lax min (5% under the quote) is refused by the on-chain quote check
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WiflyDCA.NotExecutable.selector, WiflyDCA.Skip.TooMuchSlippage));
        dca.execute(id, q2 * 95 / 100);

        // price floor above market: skipped in a batch, not reverted
        p.minWifPerEth = 5_000_000e18;
        vm.prank(alice);
        dca.updatePlan(id, p);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory mins = new uint256[](1);
        ids[0] = id;
        mins[0] = q2 * 995 / 1000;
        vm.prank(keeper);
        assertEq(dca.executeBatch(ids, mins), 0);

        // withdraw everything
        vm.prank(alice);
        dca.cancelPlan(id);
        assertEq(address(dca).balance, 0);
        assertEq(alice.balance, 10 ether - 0.002 ether);
    }
}
