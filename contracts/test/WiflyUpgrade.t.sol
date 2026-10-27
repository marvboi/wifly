// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Wifly} from "../src/Wifly.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {WiflyBadges} from "../src/WiflyBadges.sol";
import {WiflyDCA} from "../src/WiflyDCA.sol";
import {WiflyGlyphs} from "../src/render/WiflyGlyphs.sol";
import {MockWIF} from "./mocks/MockWIF.sol";
import {MockUniversalRouter, MockV4Quoter} from "./mocks/MockV4Swap.sol";
import {WiflyV2, WiflyNamesV2, WiflyBadgesV2, WiflyDCAV2, WiflyGlyphsV2, NotUUPS} from "./mocks/MockV2.sol";
import {Proxies} from "./utils/Proxies.sol";

/// @notice UUPS proxy safety for every upgradeable Wifly contract: one-time init, locked implementations,
///         owner-only upgrades, and state that survives an upgrade.
contract WiflyUpgradeTest is Test {
    MockWIF internal token;
    MockUniversalRouter internal router;
    MockV4Quoter internal quoter;
    Wifly internal w;
    WiflyNames internal n;
    WiflyBadges internal b;
    WiflyDCA internal dca;
    WiflyGlyphs internal g;

    address internal owner = makeAddr("owner");
    address internal attester = makeAddr("attester");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    address internal hooks = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockWIF();
        router = new MockUniversalRouter(token, hooks, 1_886_000e18);
        quoter = new MockV4Quoter(router);
        w = Proxies.wifly(address(token), true, owner, attester, treasury, 100e18);
        n = Proxies.names(address(token), true, owner, treasury, 100e18, 1_000e18);
        b = Proxies.badges(address(token), true, owner, "u", _thresholds());
        dca = Proxies.dca(owner, address(router), address(quoter), address(token), hooks, 0, 200);
        g = Proxies.glyphs(owner);
        token.mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        token.approve(address(w), type(uint256).max);
        token.approve(address(n), type(uint256).max);
        token.approve(address(b), type(uint256).max);
        vm.stopPrank();
        vm.deal(alice, 10 ether);
    }

    function _thresholds() internal pure returns (uint256[] memory t) {
        t = new uint256[](2);
        t[0] = 100e18;
        t[1] = 1_000e18;
    }

    function _impl(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    // ------------------------------------------------------------ initialize once
    function test_initializeTwice_reverts() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        w.initialize(address(token), true, alice, attester, treasury, 100e18);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        n.initialize(address(token), true, alice, treasury, 1, 1);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        b.initialize(address(token), true, alice, "", _thresholds());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        dca.initialize(alice, address(router), address(quoter), address(token), hooks, 0, 200);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        g.initialize(alice);
        assertEq(w.owner(), owner);
        assertEq(n.owner(), owner);
        assertEq(b.owner(), owner);
        assertEq(dca.owner(), owner);
        assertEq(g.owner(), owner);
    }

    function test_implementations_cannotBeInitialized() public {
        Wifly wi = Wifly(_impl(address(w)));
        WiflyNames ni = WiflyNames(_impl(address(n)));
        WiflyBadges bi = WiflyBadges(_impl(address(b)));
        WiflyDCA di = WiflyDCA(_impl(address(dca)));
        WiflyGlyphs gi = WiflyGlyphs(_impl(address(g)));
        vm.startPrank(alice);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        wi.initialize(address(token), true, alice, attester, treasury, 100e18);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        ni.initialize(address(token), true, alice, treasury, 1, 1);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bi.initialize(address(token), true, alice, "", _thresholds());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        di.initialize(alice, address(router), address(quoter), address(token), hooks, 0, 200);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        gi.initialize(alice);
        vm.stopPrank();
        assertEq(wi.owner(), address(0));
        assertEq(di.owner(), address(0));
    }

    /// The implementation itself refuses upgradeToAndCall (UUPS onlyProxy), so nobody can selfdestruct/brick it.
    function test_implementation_upgradeToAndCall_reverts() public {
        address wi = _impl(address(w));
        address v2 = address(new WiflyV2());
        vm.prank(owner);
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        UUPSUpgradeable(wi).upgradeToAndCall(v2, "");
    }

    // ------------------------------------------------------------ owner-only upgrades
    function test_onlyOwnerCanUpgrade() public {
        address[5] memory proxies = [address(w), address(n), address(b), address(dca), address(g)];
        address[5] memory v2s = [
            address(new WiflyV2()),
            address(new WiflyNamesV2()),
            address(new WiflyBadgesV2()),
            address(new WiflyDCAV2()),
            address(new WiflyGlyphsV2())
        ];
        for (uint256 i; i < 5; ++i) {
            address before = _impl(proxies[i]);
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
            UUPSUpgradeable(proxies[i]).upgradeToAndCall(v2s[i], "");
            assertEq(_impl(proxies[i]), before, "impl changed");
        }
    }

    /// A pending (not yet accepted) Ownable2Step owner can't upgrade either.
    function test_pendingOwnerCannotUpgrade() public {
        vm.prank(owner);
        w.transferOwnership(alice);
        address v2 = address(new WiflyV2());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        w.upgradeToAndCall(v2, "");
    }

    function test_upgradeToNonUUPS_reverts() public {
        address bad = address(new NotUUPS());
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, bad));
        w.upgradeToAndCall(bad, "");
    }

    // ------------------------------------------------------------ state survives an upgrade
    function test_upgradeWifly_preservesState() public {
        vm.prank(alice);
        w.deposit(1_000e18);
        vm.prank(alice);
        w.tip(bob, 100e18, bytes32("post"));
        vm.prank(owner);
        w.setFeeBps(300);
        token.mint(bob, 10e18);
        vm.startPrank(bob);
        token.approve(address(w), 10e18);
        w.deposit(10e18);
        vm.stopPrank(); // tips go to bob's wallet, so give him an in-contract balance to carry over
        uint256 bobBal = w.balances(bob);
        uint256 bobWallet = token.balanceOf(bob);
        uint256 pot = w.epochPot();
        uint256 burned = w.totalBurned();
        bytes32 domain = w.DOMAIN_SEPARATOR();
        assertGt(bobBal, 0);

        address v2 = address(new WiflyV2());
        vm.prank(owner);
        w.upgradeToAndCall(v2, "");

        assertEq(_impl(address(w)), v2);
        assertEq(WiflyV2(address(w)).version(), "v2");
        assertEq(w.owner(), owner);
        assertEq(address(w.wif()), address(token));
        assertTrue(w.useBurnFunction());
        assertEq(w.treasury(), treasury);
        assertEq(w.attester(), attester);
        assertEq(w.feeBps(), 300);
        assertEq(w.topSpotFloor(), 100e18);
        assertEq(w.topSpotMinHold(), 60);
        assertEq(w.gracePeriod(), 5 days);
        assertEq(w.nextHandleTipId(), 1);
        assertEq(w.winnerShareBps(), 5_000);
        assertEq(w.voterShareBps(), 5_000);
        assertEq(w.balances(alice), 1_000e18);
        assertEq(w.balances(bob), bobBal);
        assertEq(w.epochPot(), pot);
        assertEq(w.totalBurned(), burned);
        assertEq(w.DOMAIN_SEPARATOR(), domain);
        // still works after the upgrade (fee 3%: 90/10 split)
        vm.prank(alice);
        w.tip(bob, 100e18, bytes32("post2"));
        assertEq(w.balances(bob), bobBal);
        assertEq(token.balanceOf(bob), bobWallet + 97e18);
        assertEq(w.epochPot(), pot + 2.7e18);
        assertGe(token.balanceOf(address(w)), w.totalLiabilities());
    }

    function test_upgradeNames_preservesState() public {
        vm.prank(alice);
        uint256 id = n.claim("alice.wif");
        vm.prank(alice);
        n.setTheme(id, 2);
        vm.prank(alice);
        n.setText(id, "x", "@alice");
        vm.prank(owner);
        n.setPot(address(w));

        address v2 = address(new WiflyNamesV2());
        vm.prank(owner);
        n.upgradeToAndCall(v2, "");

        assertEq(WiflyNamesV2(address(n)).version(), "v2");
        assertEq(n.owner(), owner);
        assertEq(n.name(), "WIF Names");
        assertEq(n.symbol(), "WIFNAME");
        assertEq(n.ownerOf(id), alice);
        assertEq(n.reverseName(alice), "alice.wif");
        assertEq(n.theme(id), 2);
        assertEq(n.text("alice", "x"), "@alice");
        assertEq(n.feeBps(), 250);
        assertEq(n.claimFee(), 100e18);
        assertEq(address(n.pot()), address(w));
        // still transferable (not soulbound) and the theme still persists through the transfer
        vm.prank(alice);
        n.transferFrom(alice, bob, id);
        assertEq(n.ownerOf(id), bob);
        assertEq(n.theme(id), 2);
        assertEq(n.text("alice", "x"), "");
    }

    function test_upgradeBadges_preservesState() public {
        vm.prank(alice);
        b.burn(150e18);
        address v2 = address(new WiflyBadgesV2());
        vm.prank(owner);
        b.upgradeToAndCall(v2, "");

        assertEq(WiflyBadgesV2(address(b)).version(), "v2");
        assertEq(b.owner(), owner);
        assertEq(b.balanceOf(alice, 0), 1);
        assertEq(b.burnedBy(alice), 150e18);
        assertEq(b.levelsEarned(alice), 1);
        assertEq(b.levelCount(), 2);
        assertEq(b.uri(0), "u");
        // still soulbound
        vm.prank(alice);
        vm.expectRevert(WiflyBadges.Soulbound.selector);
        b.safeTransferFrom(alice, bob, 0, 1, "");
    }

    function test_upgradeDCA_preservesState_andRunsReinitializerOnce() public {
        vm.prank(owner);
        dca.setKeeper(keeper, true);
        WiflyDCA.PlanParams memory p = WiflyDCA.PlanParams({
            amountPerBuy: 0.01 ether,
            interval: 1 hours,
            maxBuys: 0,
            minWifPerEth: 1_000_000e18,
            maxSlippageBps: 100,
            keeperTip: 0
        });
        vm.prank(alice);
        uint256 id = dca.createPlan{value: 1 ether}(p, 0);

        address v2 = address(new WiflyDCAV2());
        vm.prank(owner);
        dca.upgradeToAndCall(v2, abi.encodeCall(WiflyDCAV2.initializeV2, ()));

        WiflyDCAV2 d2 = WiflyDCAV2(payable(address(dca)));
        assertEq(d2.version(), "v2");
        assertEq(d2.migrated(), 42);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        d2.initializeV2();

        assertEq(dca.owner(), owner);
        assertTrue(dca.isKeeper(keeper));
        assertEq(address(dca.router()), address(router));
        assertEq(address(dca.quoter()), address(quoter));
        assertEq(address(dca.wif()), address(token));
        assertEq(dca.hooks(), hooks);
        assertEq(dca.tickSpacing(), 200);
        assertEq(dca.nextPlanId(), 2);
        assertEq(dca.totalDeposits(), 1 ether);
        assertEq(address(dca).balance, 1 ether);
        WiflyDCA.Plan memory pl = dca.getPlan(id);
        assertEq(pl.owner, alice);
        assertEq(pl.balance, 1 ether);
        // the keeper can still buy after the upgrade
        uint256 q = router.out(0.01 ether);
        vm.prank(keeper);
        dca.execute(id, q * 99 / 100);
        assertEq(dca.getPlan(id).buysDone, 1);
        assertGt(token.balanceOf(alice), 1_000_000e18);
    }

    function test_upgradeGlyphs_preservesOutput() public {
        string memory before = g.path("a");
        (uint256 width,) = g.layout("marv.wif");
        address v2 = address(new WiflyGlyphsV2());
        vm.prank(owner);
        g.upgradeToAndCall(v2, "");
        assertEq(WiflyGlyphsV2(address(g)).version(), "v2");
        assertEq(g.path("a"), before);
        (uint256 width2,) = g.layout("marv.wif");
        assertEq(width2, width);
    }

    /// The DCA proxy, like the old contract, refuses plain ETH (no receive), so balance == totalDeposits holds.
    function test_dcaProxy_rejectsPlainEth() public {
        vm.prank(alice);
        (bool ok,) = address(dca).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(dca).balance, 0);
    }
}
