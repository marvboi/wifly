// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Wifly} from "../src/Wifly.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {FlatUpgradeLib} from "./FlatUpgradeLib.sol";

/// @notice Upgrade live Wifly + WiflyNames UUPS proxies on Robinhood Chain (4663). No new proxies.
///         Marv broadcasts from the proxy owner key; this script never embeds secrets.
contract UpgradeFlat is Script {
    uint256 constant ROBINHOOD_CHAIN_ID = 4663;
    address constant DEFAULT_WIFLY_PROXY = 0x1eeB081a4529A2905Ea888948185ADa66c0619F5;
    address constant DEFAULT_NAMES_PROXY = 0x6270008BCd75868044ae7Eb7A3a0840625033477;
    function run() external {
        require(block.chainid == ROBINHOOD_CHAIN_ID, "chain 4663 only");

        address wiflyProxy = vm.envOr("WIFLY_CONTRACT_ADDRESS", DEFAULT_WIFLY_PROXY);
        address namesProxy = vm.envOr("NAMES_CONTRACT_ADDRESS", DEFAULT_NAMES_PROXY);
        address plusCreator = vm.envOr("PLUS_CREATOR_ADDRESS", FlatUpgradeLib.DEFAULT_TREASURY);
        uint256 usdgPerWif = vm.envOr("USDG_PER_WIF", uint256(0));

        Wifly w = Wifly(payable(wiflyProxy));
        WiflyNames n = WiflyNames(payable(namesProxy));
        require(wiflyProxy.code.length > 0 && namesProxy.code.length > 0, "proxy has no code");

        address owner = w.owner();
        require(w.owner() == n.owner(), "Wifly and Names owner mismatch");
        console2.log("Proxy owner (must sign)", owner);
        console2.log("Wifly proxy", wiflyProxy);
        console2.log("Wifly impl (before)", FlatUpgradeLib.implementation(wiflyProxy));
        console2.log("Names proxy", namesProxy);
        console2.log("Names impl (before)", FlatUpgradeLib.implementation(namesProxy));

        // Signer must be `owner` (treasury by default). Use Ledger/--account/--interactive; never paste keys into files.
        vm.startBroadcast();

        address wiflyImpl = address(new Wifly());
        address namesImpl = address(new WiflyNames());
        console2.log("New Wifly implementation", wiflyImpl);
        console2.log("New WiflyNames implementation", namesImpl);

        FlatUpgradeLib.upgradeWifly(w, wiflyImpl, plusCreator);
        FlatUpgradeLib.upgradeNames(n, namesImpl);

        if (usdgPerWif > 0) {
            w.setUsdgPerWif(usdgPerWif);
            n.setUsdgPerWif(usdgPerWif);
            console2.log("USDG_PER_WIF set on Wifly + Names", usdgPerWif);
        }

        vm.stopBroadcast();

        console2.log("Wifly impl (after)", FlatUpgradeLib.implementation(wiflyProxy));
        console2.log("Names impl (after)", FlatUpgradeLib.implementation(namesProxy));
        console2.log("Wifly flat init done", FlatUpgradeLib.wiflyFlatDone(w));
        console2.log("Wifly v3 init done", FlatUpgradeLib.wiflyV3Done(w));
        console2.log("Wifly v4 init done", FlatUpgradeLib.wiflyV4Done(w));
        console2.log("Names v2 init done", FlatUpgradeLib.namesV2Done(n));
        console2.log("Names v3 init done", FlatUpgradeLib.namesV3Done(n));
    }
}