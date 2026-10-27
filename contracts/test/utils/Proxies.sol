// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Wifly} from "../../src/Wifly.sol";
import {WiflyNames} from "../../src/WiflyNames.sol";
import {WiflyBadges} from "../../src/WiflyBadges.sol";
import {WiflyDCA} from "../../src/WiflyDCA.sol";
import {WiflyGlyphs} from "../../src/render/WiflyGlyphs.sol";

/// @notice Test helpers: deploy each Wifly contract the way production does (implementation + ERC1967Proxy with
///         the initialize calldata). Same arguments as the old constructors.
library Proxies {
    function wifly(address wif, bool useBurn, address owner, address attester, address treasury, uint256 floor)
        internal
        returns (Wifly)
    {
        return wiflyWith(address(new Wifly()), wif, useBurn, owner, attester, treasury, floor);
    }

    function wiflyWith(
        address impl,
        address wif,
        bool useBurn,
        address owner,
        address attester,
        address treasury,
        uint256 floor
    ) internal returns (Wifly) {
        bytes memory init = abi.encodeCall(Wifly.initialize, (wif, useBurn, owner, attester, treasury, floor));
        return Wifly(address(new ERC1967Proxy(impl, init)));
    }

    function names(address wif, bool useBurn, address owner, address treasury, uint256 fee, uint256 shortFee)
        internal
        returns (WiflyNames)
    {
        bytes memory init = abi.encodeCall(WiflyNames.initialize, (wif, useBurn, owner, treasury, fee, shortFee));
        return WiflyNames(address(new ERC1967Proxy(address(new WiflyNames()), init)));
    }

    function badges(address wif, bool useBurn, address owner, string memory uri, uint256[] memory thresholds)
        internal
        returns (WiflyBadges)
    {
        bytes memory init = abi.encodeCall(WiflyBadges.initialize, (wif, useBurn, owner, uri, thresholds));
        return WiflyBadges(address(new ERC1967Proxy(address(new WiflyBadges()), init)));
    }

    function dca(
        address owner,
        address router,
        address quoter,
        address wif,
        address hooks,
        uint24 poolFee,
        int24 tickSpacing
    ) internal returns (WiflyDCA) {
        bytes memory init =
            abi.encodeCall(WiflyDCA.initialize, (owner, router, quoter, wif, hooks, poolFee, tickSpacing));
        return WiflyDCA(address(new ERC1967Proxy(address(new WiflyDCA()), init)));
    }

    function glyphs(address owner) internal returns (WiflyGlyphs) {
        bytes memory init = abi.encodeCall(WiflyGlyphs.initialize, (owner));
        return WiflyGlyphs(address(new ERC1967Proxy(address(new WiflyGlyphs()), init)));
    }
}
