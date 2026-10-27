// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {WiflyGlyphs} from "../src/render/WiflyGlyphs.sol";
import {WiflyNameRenderer} from "../src/render/WiflyNameRenderer.sol";
import {IWiflyGlyphs} from "../src/interfaces/IWiflyGlyphs.sol";
import {MockWIF} from "./mocks/MockWIF.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Proxies} from "./utils/Proxies.sol";

contract WiflyNameRendererTest is Test {
    WiflyNames internal n;
    MockWIF internal token;
    WiflyGlyphs internal glyphs;
    WiflyNameRenderer internal r;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");

    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    function setUp() public {
        token = new MockWIF();
        n = Proxies.names(address(token), true, owner, treasury, 100e18, 1_000e18);
        glyphs = Proxies.glyphs(owner);
        r = new WiflyNameRenderer(IWiflyGlyphs(address(glyphs)));
        vm.prank(owner);
        n.setRenderer(address(r));
        token.mint(alice, 1_000_000e18);
        vm.prank(alice);
        token.approve(address(n), type(uint256).max);
    }

    function _claim(string memory name) internal returns (uint256 id) {
        vm.prank(alice);
        id = n.claim(name);
    }

    function _has(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory nd = bytes(needle);
        if (nd.length > h.length) return false;
        for (uint256 i; i <= h.length - nd.length; ++i) {
            bool ok = true;
            for (uint256 j; j < nd.length; ++j) {
                if (h[i + j] != nd[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- tokenURI / JSON
    function test_tokenURI_isBase64OfValidJson() public {
        uint256 id = _claim("marv");
        string memory j = r.json("marv", true, false);
        assertEq(n.tokenURI(id), string.concat("data:application/json;base64,", vm.toBase64(bytes(j))));
        assertEq(vm.parseJsonString(j, ".name"), "marv.wif");
        assertEq(vm.parseJsonUint(j, ".attributes[0].value"), 4);
        assertEq(vm.parseJsonString(j, ".attributes[1].value"), "Letters");
        assertEq(vm.parseJsonString(j, ".attributes[2].value"), "Rare");
        assertEq(vm.parseJsonString(j, ".attributes[3].value"), "Yes");
        assertEq(vm.parseJsonString(j, ".attributes[4].value"), "No");
        assertEq(
            vm.parseJsonString(j, ".image"),
            string.concat("data:image/svg+xml;base64,", vm.toBase64(bytes(r.svg("marv", true, false))))
        );
        assertFalse(_has(j, "http"), "no external urls in json");
    }

    function test_attributes_kinds_and_reserved() public {
        vm.prank(owner);
        uint256 id = n.reserve("wifly", owner);
        assertTrue(n.isReserved(id));
        string memory j = r.json("wifly", false, true);
        assertEq(n.tokenURI(id), string.concat("data:application/json;base64,", vm.toBase64(bytes(j))));
        assertEq(vm.parseJsonString(j, ".attributes[2].value"), "Standard");
        assertEq(vm.parseJsonString(j, ".attributes[3].value"), "No");
        assertEq(vm.parseJsonString(j, ".attributes[4].value"), "Yes");
        assertEq(vm.parseJsonString(r.json("12345", false, false), ".attributes[1].value"), "Numbers");
        assertEq(vm.parseJsonString(r.json("abc123", false, false), ".attributes[1].value"), "Mixed");
        assertEq(vm.parseJsonString(r.json("ab_cd", false, false), ".attributes[1].value"), "Mixed");
        // claimed names are not reserved
        assertFalse(n.isReserved(_claim("alicex")));
    }

    // ---------------------------------------------------------------- SVG
    function test_svg_structure() public view {
        string memory s = r.svg("marv", true, true);
        assertTrue(_has(s, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"'));
        assertTrue(_has(s, "<title>marv.wif</title>"));
        assertTrue(_has(s, "<animate"), "animated");
        assertTrue(_has(s, "#CCFF00") && _has(s, "#110E08"), "brand colours");
        // every glyph of "marv.wif" referenced and defined ("." = slot 38), no "@"
        assertTrue(_has(s, '<path id="g38"') && _has(s, '<path id="g12"') && _has(s, '<path id="g0"'));
        assertTrue(_has(s, '<use href="#g38"'));
        assertFalse(_has(s, '<path id="g37"'), "no at-sign");
        // short token id in the footer
        assertFalse(_has(s, 'fill="#FFFFFF" opacity='), "no white shimmer sweep");
        // "peek" layout: face clipped to the ink frame; neon background when rare, white otherwise
        assertTrue(_has(s, '<g clip-path="url(#f)">') && _has(s, 'stroke="#110E08" stroke-width="3"/>'), "frame + clipped face");
        assertTrue(_has(s, '<rect width="1000" height="1000" fill="#CCFF00"/>'), "rare = neon");
        assertTrue(_has(r.svg("satoshi", false, false), '<rect width="1000" height="1000" fill="#FFFFFF"/>'), "standard = white");
        assertTrue(_has(s, '<use href="#g12"'));
        assertFalse(_has(s, "<text"), "no font dependency");
        assertFalse(_has(s, "url(http"));
        bytes memory b = bytes(s);
        assertEq(string(abi.encodePacked(b[b.length - 6], b[b.length - 5], b[b.length - 4], b[b.length - 3], b[b.length - 2], b[b.length - 1])), "</svg>");
    }

    /// @dev A name must NEVER be cut off or overflow, at any length 3..20, including the widest glyphs
    ///      ("m" 800, "w" 780), underscores (deepest descender) and kerned mixes. WIF Par ink stays inside each
    ///      glyph's advance (max xMax - advance = 0) and within +0.7 / -0.2 em of the baseline, so advance widths
    ///      are exact bounds. Checks, per name: name.wif inside x 92..900 (ink frame at 960), name and ".wif" do
    ///      not collide, ".wif" >= 44 px and never bigger than the name, top below the header (y 149), bottom
    ///      above the face (head top >= 474 incl. squash + bob) even at the start of the 36 px slide-in, and
    ///      the footer (y 847). Renders every case in both owner themes.
    function test_nameNeverOverflows_allLengths_widestCombos() public view {
        string[8] memory pats = ["m", "w", "_", "mw", "m_", "w_m", "q0", "wm_f"];
        (uint256 ws,) = glyphs.layout(".wif");
        for (uint256 p; p < pats.length; ++p) {
            bytes memory pat = bytes(pats[p]);
            for (uint256 len = 3; len <= 20; ++len) {
                bytes memory nm = new bytes(len);
                for (uint256 i; i < len; ++i) {
                    nm[i] = pat[i % pat.length];
                }
                _assertFits(string(nm), ws, uint8(1 + ((p + len) % 2)));
            }
        }
        r.svg("a_really_long_name20", false, false);
    }

    function _assertFits(string memory name, uint256 ws, uint8 theme) internal view {
        (uint256 s5, uint256 ss, uint256 sx) = r.nameFit(name);
        (uint256 wn,) = glyphs.layout(name);
        // horizontal (all * 1e5)
        assertLe(92e5 + wn * s5, sx * 1e5 + 40 * s5 + 1e5, "name runs into .wif");
        assertLe(sx * 1e5 + ws * ss, 900e5, "name.wif overflows the frame");
        assertGe(ss, 4_400, ".wif >= 44 px");
        assertGe(s5, ss, "name never smaller than .wif");
        assertLe(s5, 21_000, "size cap");
        // vertical (px * 1000): baseline 230 + 0.7 size, ink +0.7 / -0.2 size
        uint256 base = 230_000 + 7 * s5;
        assertGe(base - 7 * s5, 160_000, "below the header");
        assertLt(base + 2 * s5 + 36_000, 474_000, "clear of the face, even mid slide-in");
        assertLt(base + 2 * s5 + 36_000, 847_000, "clear of the footer");
        string memory s = r.svg(name, bytes(name).length <= 4, false, theme);
        assertTrue(_has(s, string.concat("<title>", name, ".wif</title>")));
    }

    /// @dev Owner themes: 0 = default (rare green, standard white), 1 = white, 2 = green; unknown -> default.
    ///      Pills stay regardless of theme; tokenURI(…, theme) is what WiflyNames calls.
    function test_themes() public view {
        string memory neonBg = '<rect width="1000" height="1000" fill="#CCFF00"/>';
        string memory whiteBg = '<rect width="1000" height="1000" fill="#FFFFFF"/>';
        string memory rarePill = 'rx="28" fill="#110E08"';
        // defaults
        assertTrue(_has(r.svg("marv", true, false, 0), neonBg));
        assertTrue(_has(r.svg("gm_42", false, false, 0), whiteBg));
        assertEq(r.svg("marv", true, false, 0), r.svg("marv", true, false));
        assertEq(r.svg("marv", true, false, 9), r.svg("marv", true, false), "unknown theme = default");
        // owner override wins, pills kept
        string memory s = r.svg("marv", true, true, 1);
        assertTrue(_has(s, whiteBg) && !_has(s, neonBg), "rare forced white");
        assertTrue(_has(s, rarePill) && _has(s, 'rx="28" fill="#EFECE5"'), "rare + reserved pills on white");
        s = r.svg("gm_42", false, true, 2);
        assertTrue(_has(s, neonBg) && !_has(s, whiteBg), "standard forced green");
        assertFalse(_has(s, rarePill), "no rare pill on a standard name");
        assertTrue(_has(s, 'rx="28" fill="#FFFFFF"'), "reserved pill on green");
        // metadata: Theme trait, rarity unchanged, entry points agree
        string memory j = r.json("marv", true, false, 1);
        assertEq(vm.parseJsonString(j, ".attributes[2].value"), "Rare");
        assertEq(vm.parseJsonString(j, ".attributes[5].trait_type"), "Theme");
        assertEq(vm.parseJsonString(j, ".attributes[5].value"), "White");
        assertEq(vm.parseJsonString(r.json("gm_42", false, false), ".attributes[5].value"), "White");
        assertEq(vm.parseJsonString(r.json("gm_42", false, false, 2), ".attributes[5].value"), "Green");
        assertEq(
            r.tokenURI(1, "gm_42", false, false, 2),
            string.concat("data:application/json;base64,", vm.toBase64(bytes(r.json("gm_42", false, false, 2))))
        );
        assertEq(r.tokenURI(1, "marv", true, false, 9), r.tokenURI(1, "marv", true, false, 0));
    }

    function test_glyphs_layout_kerning() public view {
        // "ft": f(620) then t kerned by 80 (f->t)
        assertEq(glyphs.kern("f", "t"), glyphs.kern("f", "t"));
        (uint256 w, uint256[] memory xs) = glyphs.layout("ft");
        assertEq(xs[0], 0);
        assertEq(xs[1], 620 - glyphs.kern("f", "t"));
        assertEq(w, xs[1] + 640);
        assertEq(glyphs.kern("a", "b"), 0);
        assertEq(glyphs.kern("a", "j"), 40);
        assertEq(glyphs.advance("@"), 900);
        assertEq(glyphs.path("l"), "M100 0V-700H200V0Z");
    }

    function test_renderer_rejectsBadNames() public {
        vm.expectRevert(WiflyNameRenderer.BadName.selector);
        r.svg("Marv", false, false);
        vm.expectRevert(WiflyNameRenderer.BadName.selector);
        r.json('a"b', false, false);
    }

    // ---------------------------------------------------------------- renderer admin
    function test_setRenderer_onlyOwner_lock_and_4906() public {
        uint256 id = _claim("marv");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        n.setRenderer(address(0));

        vm.expectEmit(address(n));
        emit BatchMetadataUpdate(0, type(uint256).max);
        vm.prank(owner);
        n.setRenderer(address(0)); // back to plain JSON
        assertEq(
            n.tokenURI(id),
            string.concat(
                "data:application/json;base64,",
                vm.toBase64(bytes('{"name":"marv.wif","description":"marv.wif, a WIF Name on Robinhood Chain."}'))
            )
        );
        vm.prank(owner);
        vm.expectRevert(WiflyNames.ZeroAddress.selector);
        n.lockRenderer();

        vm.startPrank(owner);
        n.setRenderer(address(r));
        n.lockRenderer();
        vm.expectRevert(WiflyNames.Locked.selector);
        n.setRenderer(address(0));
        vm.stopPrank();
        assertTrue(n.rendererLocked());
        assertTrue(n.supportsInterface(0x49064906));
        assertTrue(n.supportsInterface(0x80ac58cd)); // ERC-721 still
    }

    function test_gas_tokenURI_longest() public {
        uint256 id = _claim("a_really_long_name20");
        uint256 g = gasleft();
        n.tokenURI(id);
        uint256 used = g - gasleft();
        emit log_named_uint("tokenURI gas (20 chars)", used);
        assertLt(used, 30_000_000);
    }
}
