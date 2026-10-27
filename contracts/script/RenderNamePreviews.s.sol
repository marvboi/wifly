// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {WiflyGlyphs} from "../src/render/WiflyGlyphs.sol";
import {WiflyNameRenderer} from "../src/render/WiflyNameRenderer.sol";
import {IWiflyGlyphs} from "../src/interfaces/IWiflyGlyphs.sol";

/// @notice Local preview only (no broadcast, no keys): writes tokenURI + SVG for sample names to ../brand/name-nft.
///   forge script script/RenderNamePreviews.s.sol
contract RenderNamePreviews is Script {
    function run() external {
        WiflyNameRenderer r = new WiflyNameRenderer(IWiflyGlyphs(address(new WiflyGlyphs())));
        string[5] memory names = ["marv", "wifly", "wif", "satoshi_nakamoto20", "a_really_long_name20"];
        bool[5] memory reserved = [false, true, true, false, false];
        for (uint256 i; i < names.length; ++i) {
            bool rare = bytes(names[i]).length <= 4;
            string memory base = string.concat("../brand/name-nft/", names[i]);
            vm.writeFile(string.concat(base, ".svg"), r.svg(names[i], rare, reserved[i]));
            vm.writeFile(string.concat(base, ".tokenuri.txt"), r.tokenURI(0, names[i], rare, reserved[i], 0));
        }
        // a plain claimed short name, no pills except rare
        vm.writeFile("../brand/name-nft/gm_42.svg", r.svg("gm_42", false, false));
        vm.writeFile("../brand/name-nft/gm_42.tokenuri.txt", r.tokenURI(0, "gm_42", false, false, 0));
        // owner-chosen themes (file suffix ~white / ~green): override the rare/standard default
        _themed(r, "marv", true, false, 1);
        _themed(r, "gm_42", false, false, 2);
        _themed(r, "satoshi_nakamoto20", false, false, 2);
        _themed(r, "a_really_long_name20", false, false, 2);
        // widest possible 20-char names (fit stress)
        _themed(r, "mmmmmmmmmmmmmmmmmmmm", false, false, 1);
        _themed(r, "wwwwwwwwwwwwwwwwwwww", false, false, 2);
        _themed(r, "m_m_m_m_m_m_m_m_m_m_", false, false, 1);
    }

    function _themed(WiflyNameRenderer r, string memory name, bool rare, bool reserved, uint8 theme) internal {
        string memory base = string.concat("../brand/name-nft/", name, theme == 1 ? "~white" : "~green");
        vm.writeFile(string.concat(base, ".svg"), r.svg(name, rare, reserved, theme));
        vm.writeFile(string.concat(base, ".tokenuri.txt"), r.tokenURI(0, name, rare, reserved, theme));
    }
}
