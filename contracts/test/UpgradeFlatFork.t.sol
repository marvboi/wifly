// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Wifly} from "../src/Wifly.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {FlatUpgradeLib} from "../script/FlatUpgradeLib.sol";

/// @notice Fork rehearsal: upgrade live proxies on a 4663 fork as the real owner; assert storage + sample flows.
///         RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract UpgradeFlatFork -vv
contract UpgradeFlatForkTest is Test {
    uint256 constant ROBINHOOD_CHAIN_ID = 4663;
    address constant WIFLY_PROXY = 0x1eeB081a4529A2905Ea888948185ADa66c0619F5;
    address constant NAMES_PROXY = 0x6270008BCd75868044ae7Eb7A3a0840625033477;
    address constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // Marv: Plus creator = treasury / proxy owner (deploy default); override via PLUS_CREATOR_ADDRESS only if needed.
    address constant EXPECTED_PLUS_CREATOR = FlatUpgradeLib.DEFAULT_TREASURY;

    IERC20 constant wif = IERC20(WIF);
    Wifly w;
    WiflyNames n;
    address owner;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("RH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        assertEq(block.chainid, ROBINHOOD_CHAIN_ID);
        w = Wifly(payable(WIFLY_PROXY));
        n = WiflyNames(payable(NAMES_PROXY));
        owner = w.owner();
    }

    function test_fork_flatUpgrade_rehearsal() public {
        if (!forked) {
            vm.skip(true);
            return;
        }

        address plusCreator = vm.envOr("PLUS_CREATOR_ADDRESS", EXPECTED_PLUS_CREATOR);
        assertEq(plusCreator, EXPECTED_PLUS_CREATOR, "fork rehearsal uses treasury as Plus creator");
        address implBeforeW = FlatUpgradeLib.implementation(WIFLY_PROXY);
        address implBeforeN = FlatUpgradeLib.implementation(NAMES_PROXY);

        address treasury = w.treasury();
        address attester = w.attester();
        uint256 feeBps = w.feeBps();
        uint256 topFloor = w.topSpotFloor();
        uint256 epochPot = w.epochPot();
        uint256 burned = w.totalBurned();

        // Sample existing balance if treasury has one
        uint256 treasuryBal = w.balances(treasury);

        // Upgrade as proxy owner (Marv treasury by default on mainnet)
        vm.startPrank(owner);
        address wiflyImpl = address(new Wifly());
        address namesImpl = address(new WiflyNames());
        FlatUpgradeLib.upgradeWifly(w, wiflyImpl, plusCreator);
        FlatUpgradeLib.upgradeNames(n, namesImpl);
        vm.stopPrank();

        address implAfterW = FlatUpgradeLib.implementation(WIFLY_PROXY);
        address implAfterN = FlatUpgradeLib.implementation(NAMES_PROXY);
        assertTrue(implAfterW != implBeforeW, "Wifly implementation must change");
        assertTrue(implAfterN != implBeforeN, "Names implementation must change");
        assertEq(implAfterW, wiflyImpl);
        assertEq(implAfterN, namesImpl);

        assertEq(w.owner(), owner, "owner unchanged");
        assertEq(n.owner(), owner);
        assertEq(address(w.wif()), WIF);
        assertEq(w.treasury(), treasury);
        assertEq(w.attester(), attester);
        assertEq(w.feeBps(), feeBps);
        assertEq(w.topSpotFloor(), topFloor);
        assertEq(w.epochPot(), epochPot);
        assertEq(w.totalBurned(), burned);
        assertEq(w.balances(treasury), treasuryBal);

        assertTrue(FlatUpgradeLib.wiflyFlatDone(w));
        assertEq(w.feeTreasuryBps(), 2_000);
        assertEq(w.feeBurnBps(), 1_000);

        assertTrue(FlatUpgradeLib.wiflyV3Done(w));
        assertEq(address(w.usdg()), USDG);
        assertEq(w.minVoteAmount(), 30e18);

        assertTrue(FlatUpgradeLib.wiflyV4Done(w));
        assertEq(w.plusCreator(), plusCreator);
        uint256[3] memory m = w.tierPrices(plusCreator);
        uint256[3] memory y = w.yearlyPrices(plusCreator);
        assertEq(m[0], 3_000e18);
        assertEq(y[0], 30_000e18);

        assertTrue(FlatUpgradeLib.namesV2Done(n));
        assertEq(n.claimFeeOf("marvellous"), 200e18);
        assertEq(n.claimFeeOf("four"), 2_000e18);
        assertEq(n.claimFeeOf("thr"), 4_000e18);
        assertEq(n.claimFeeOf("ab"), 8_000e18);

        assertTrue(FlatUpgradeLib.namesV3Done(n));
        assertEq(address(n.usdg()), USDG);

        // Sample name claim + Plus subscribe post-upgrade
        address buyer = makeAddr("buyer");
        deal(WIF, buyer, 50_000e18, true);
        vm.startPrank(buyer);
        wif.approve(address(n), type(uint256).max);
        wif.approve(address(w), type(uint256).max);
        string memory label = string.concat("uf", vm.toString(block.timestamp));
        uint256 id = n.claim(label);
        assertEq(n.ownerOf(id), buyer);

        w.subscribePlan(plusCreator, 0, 0);
        vm.stopPrank();

        console2.log("FORK REHEARSAL OK");
        console2.log("Wifly impl", implAfterW);
        console2.log("Names impl", implAfterN);
        console2.log("claimed name id", id);
    }
}