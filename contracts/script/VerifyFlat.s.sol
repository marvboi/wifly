// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Wifly} from "../src/Wifly.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {FlatUpgradeLib} from "./FlatUpgradeLib.sol";

/// @notice Read-only flat-upgrade verification on Robinhood Chain (4663). No broadcast.
contract VerifyFlat is Script {
    uint256 constant ROBINHOOD_CHAIN_ID = 4663;
    address constant DEFAULT_WIFLY_PROXY = 0x1eeB081a4529A2905Ea888948185ADa66c0619F5;
    address constant DEFAULT_NAMES_PROXY = 0x6270008BCd75868044ae7Eb7A3a0840625033477;
    address constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;

    function run() external view {
        require(block.chainid == ROBINHOOD_CHAIN_ID, "chain 4663 only");

        address wiflyProxy = vm.envOr("WIFLY_CONTRACT_ADDRESS", DEFAULT_WIFLY_PROXY);
        address namesProxy = vm.envOr("NAMES_CONTRACT_ADDRESS", DEFAULT_NAMES_PROXY);

        Wifly w = Wifly(payable(wiflyProxy));
        WiflyNames n = WiflyNames(payable(namesProxy));

        console2.log("=== Flat upgrade verify (read-only) ===");
        console2.log("chainId", block.chainid);
        console2.log("Wifly proxy", wiflyProxy);
        console2.log("Wifly implementation", FlatUpgradeLib.implementation(wiflyProxy));
        console2.log("Wifly owner", w.owner());
        console2.log("Names proxy", namesProxy);
        console2.log("Names implementation", FlatUpgradeLib.implementation(namesProxy));
        console2.log("Names owner", n.owner());
        console2.log("owners match", w.owner() == n.owner());

        console2.log("--- Wifly fee split (expect 70/10/20 pot/burn/treasury when flat on) ---");
        console2.log("feeSplitSet", w.feeSplitSet());
        console2.log("feeTreasuryBps (expect 2000)", w.feeTreasuryBps());
        console2.log("feeBurnBps (expect 1000)", w.feeBurnBps());
        console2.log("feeBps", w.feeBps());
        console2.log("epochPot", w.epochPot());
        console2.log("totalBurned", w.totalBurned());

        console2.log("--- Wifly USDG + vote ---");
        console2.log("usdg (expect 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168)", address(w.usdg()));
        console2.log("usdgPerWif", w.usdgPerWif());
        console2.log("minVoteAmount (expect 30e18)", w.minVoteAmount());

        console2.log("--- Wifly Plus ---");
        address pc = w.plusCreator();
        console2.log("plusCreator", pc);
        if (pc != address(0)) {
            uint256[3] memory months = w.tierPrices(pc);
            uint256[3] memory yearly = w.yearlyPrices(pc);
            console2.log("tier0 monthly WIF (expect 3000e18)", months[0]);
            console2.log("tier0 yearly WIF (expect 30000e18)", yearly[0]);
        }

        console2.log("--- WiflyNames tier fees (expect 200/2000/4000/8000 wif) ---");
        console2.log("claimFee (5+)", n.claimFee());
        console2.log("shortClaimFee (4)", n.shortClaimFee());
        console2.log("claimFee3 (3)", n.claimFee3());
        console2.log("claimFee2 (2)", n.claimFee2());
        console2.log("claim sample marvellous", n.claimFeeOf("marvellous"));
        console2.log("claim sample four", n.claimFeeOf("four"));
        console2.log("claim sample thr", n.claimFeeOf("thr"));
        console2.log("claim sample ab (2-char)", n.claimFeeOf("ab"));

        console2.log("--- WiflyNames USDG ---");
        console2.log("names usdg", address(n.usdg()));
        console2.log("names usdgPerWif", n.usdgPerWif());

        console2.log("--- Reinitializer / flat flags ---");
        console2.log("wiflyFlatDone", FlatUpgradeLib.wiflyFlatDone(w));
        console2.log("wiflyV3Done", FlatUpgradeLib.wiflyV3Done(w));
        console2.log("wiflyV4Done", FlatUpgradeLib.wiflyV4Done(w));
        console2.log("namesV2Done", FlatUpgradeLib.namesV2Done(n));
        console2.log("namesV3Done", FlatUpgradeLib.namesV3Done(n));

        console2.log("--- Misc ---");
        console2.log("wif token", address(w.wif()));
        console2.log("wif token matches canonical", address(w.wif()) == WIF);
        console2.log("names wif token", address(n.wif()));
        console2.log("names pot", address(n.pot()));
        console2.log("names treasury", n.treasury());
    }
}