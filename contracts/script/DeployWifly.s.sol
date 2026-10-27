// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Wifly} from "../src/Wifly.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {WiflyBadges} from "../src/WiflyBadges.sol";
import {WiflyDCA} from "../src/WiflyDCA.sol";
import {WiflyGlyphs} from "../src/render/WiflyGlyphs.sol";
import {WiflyNameRenderer} from "../src/render/WiflyNameRenderer.sol";
import {IWiflyGlyphs} from "../src/interfaces/IWiflyGlyphs.sol";

/// @notice Deploys the Wifly contracts behind UUPS proxies (initialized in the same tx) on Robinhood Chain (4663).
contract DeployWifly is Script {
    uint256 constant ROBINHOOD_CHAIN_ID = 4663;
    address constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;
    address constant DEFAULT_TREASURY = 0x8E5f84738C0fb29670F370F73E53BD234CEfeF21;
    // Uniswap v4 on Robinhood Chain and the ETH/WIF pool.
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address constant WIF_POOL_HOOKS = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    uint24 constant WIF_POOL_FEE = 0;
    int24 constant WIF_POOL_TICK_SPACING = 200;

    /// @dev Contract fields are proxy addresses; *Impl are the implementations.
    struct Deployed {
        Wifly wifly;
        WiflyNames names;
        WiflyBadges badges;
        WiflyGlyphs glyphs;
        WiflyNameRenderer renderer;
        WiflyDCA dca;
        address wiflyImpl;
        address namesImpl;
        address badgesImpl;
        address glyphsImpl;
        address dcaImpl;
    }

    function run() external returns (Deployed memory d) {
        require(block.chainid == ROBINHOOD_CHAIN_ID, "chain 4663 only");
        require(WIF.code.length > 0, "WIF has no code on this chain");

        address attester = vm.envAddress("WIFLY_ATTESTER");
        // Receives 50% of .wif claim fees.
        address treasury = vm.envOr("WIFLY_TREASURY", DEFAULT_TREASURY);
        // Owner of every proxy; defaults to the treasury.
        address owner = vm.envOr("WIFLY_OWNER", treasury);
        uint256 floor = vm.envOr("WIFLY_TOP_SPOT_FLOOR", uint256(100e18));
        bool useBurn = vm.envOr("WIFLY_USE_BURN", true);

        uint256 claimFee = vm.envOr("NAMES_CLAIM_FEE", uint256(100e18));
        uint256 shortFee = vm.envOr("NAMES_SHORT_FEE", uint256(1_000e18));
        string memory badgeUri = vm.envOr("BADGES_URI", string("https://wifly.fun/badges/{id}.json"));
        uint256[] memory thresholds = vm.envOr("BADGE_THRESHOLDS", ",", _defaultThresholds());
        // Keeper allowed to run DCA buys.
        address keeper = vm.envOr("WIFLY_KEEPER", address(0));

        vm.startBroadcast();
        d.wiflyImpl = address(new Wifly());
        d.wifly = Wifly(
            _proxy(d.wiflyImpl, abi.encodeCall(Wifly.initialize, (WIF, useBurn, owner, attester, treasury, floor)))
        );
        if (vm.envOr("DEPLOY_NAMES", true)) {
            d.namesImpl = address(new WiflyNames());
            d.names = WiflyNames(
                _proxy(
                    d.namesImpl,
                    abi.encodeCall(WiflyNames.initialize, (WIF, useBurn, owner, treasury, claimFee, shortFee))
                )
            );
            // on-chain name art: glyphs (proxy) and renderer (plain contract)
            d.glyphsImpl = address(new WiflyGlyphs());
            d.glyphs = WiflyGlyphs(_proxy(d.glyphsImpl, abi.encodeCall(WiflyGlyphs.initialize, (owner))));
            d.renderer = new WiflyNameRenderer(IWiflyGlyphs(address(d.glyphs)));
        }
        if (vm.envOr("DEPLOY_BADGES", true)) {
            d.badgesImpl = address(new WiflyBadges());
            d.badges = WiflyBadges(
                _proxy(d.badgesImpl, abi.encodeCall(WiflyBadges.initialize, (WIF, useBurn, owner, badgeUri, thresholds)))
            );
        }
        if (vm.envOr("DEPLOY_DCA", true)) {
            require(UNIVERSAL_ROUTER.code.length > 0 && V4_QUOTER.code.length > 0, "Uniswap v4 not on this chain");
            d.dcaImpl = address(new WiflyDCA());
            d.dca = WiflyDCA(
                _proxy(
                    d.dcaImpl,
                    abi.encodeCall(
                        WiflyDCA.initialize,
                        (owner, UNIVERSAL_ROUTER, V4_QUOTER, WIF, WIF_POOL_HOOKS, WIF_POOL_FEE, WIF_POOL_TICK_SPACING)
                    )
                )
            );
            // owner only
            if (keeper != address(0) && owner == msg.sender) d.dca.setKeeper(keeper, true);
        }
        // Owner-only setup: renderer, pot and reserved names.
        if (address(d.names) != address(0) && owner == msg.sender) {
            d.names.setRenderer(address(d.renderer));
            // name fees' pot share goes to the Wifly pot
            d.names.setPot(address(d.wifly));
            address reserveTo = vm.envOr("NAMES_RESERVE_TO", owner);
            string[] memory reserved = vm.envOr("NAMES_RESERVED", ",", _defaultReserved());
            for (uint256 i; i < reserved.length; ++i) {
                d.names.reserve(reserved[i], reserveTo);
            }
        }
        vm.stopBroadcast();

        console2.log("Wifly        proxy", address(d.wifly));
        console2.log("             impl ", d.wiflyImpl);
        console2.log("WiflyNames   proxy (WIF Names, .wif)", address(d.names));
        console2.log("             impl ", d.namesImpl);
        console2.log("WiflyBadges  proxy", address(d.badges));
        console2.log("             impl ", d.badgesImpl);
        console2.log("WiflyGlyphs  proxy", address(d.glyphs));
        console2.log("             impl ", d.glyphsImpl);
        console2.log("NameRenderer (plain, swappable)", address(d.renderer));
        console2.log("WiflyDCA     proxy", address(d.dca));
        console2.log("             impl ", d.dcaImpl);
        console2.log("DCA keeper ", keeper);
        console2.log("owner      ", owner);
        console2.log("attester   ", attester);
        console2.log("treasury   ", treasury);
    }

    function _proxy(address impl, bytes memory init) internal returns (address) {
        return address(new ERC1967Proxy(impl, init));
    }

    /// @dev Default reserved names (bare labels).
    function _defaultReserved() internal pure returns (string[] memory r) {
        r = new string[](3);
        r[0] = "wifly";
        r[1] = "marv";
        r[2] = "wif";
    }

    /// @dev 1k / 10k / 100k / 1M WIF burned.
    function _defaultThresholds() internal pure returns (uint256[] memory t) {
        t = new uint256[](4);
        t[0] = 1_000e18;
        t[1] = 10_000e18;
        t[2] = 100_000e18;
        t[3] = 1_000_000e18;
    }
}
