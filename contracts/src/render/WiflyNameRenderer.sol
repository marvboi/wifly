// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IWiflyNameRenderer} from "../interfaces/IWiflyNameRenderer.sol";
import {IWiflyGlyphs} from "../interfaces/IWiflyGlyphs.sol";

/// @title WiflyNameRenderer
/// @notice Fully on-chain metadata and animated SVG art for WiflyNames.
contract WiflyNameRenderer is IWiflyNameRenderer {
    using Strings for uint256;

    IWiflyGlyphs public immutable glyphs;

    // brand colours
    string internal constant INK = "#110E08";
    string internal constant NEON = "#CCFF00";
    string internal constant PAPER = "#F7F5F0";
    string internal constant LINE = "#ECE9E2";
    string internal constant MUTED = "#6F6A60";
    string internal constant SUBTLE = "#A39E93";


    error BadName();

    constructor(IWiflyGlyphs glyphs_) {
        glyphs = glyphs_;
    }

    // ================================================================ metadata
    /// @notice Card themes; any unknown value falls back to the default.
    uint8 public constant THEME_DEFAULT = 0; // rare -> green, standard -> white
    uint8 public constant THEME_WHITE = 1;
    uint8 public constant THEME_GREEN = 2;

    /// @notice Token URI. `theme`: 0 = default, 1 = white, 2 = green.
    function tokenURI(uint256, string calldata name, bool rare, bool reserved, uint8 theme)
        external
        view
        returns (string memory)
    {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json(name, rare, reserved, theme))));
    }

    function json(string calldata name, bool rare, bool reserved) public view returns (string memory) {
        return json(name, rare, reserved, 0);
    }

    function json(string calldata name, bool rare, bool reserved, uint8 theme) public view returns (string memory) {
        _check(name);
        bool green = _green(rare, theme);
        return string.concat(
            '{"name":"',
            name,
            '.wif","description":"',
            name,
            ".wif is a WIF Name, owned on-chain as this token. Whoever holds it owns the name: it resolves to a wallet across the WIF ecosystem, can be set as a primary name, and can be bought or sold on the WIF Names market. Art and metadata are fully on-chain.",
            '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_svg(name, rare, reserved, green))),
            _attributes(name, rare, reserved),
            green ? ',{"trait_type":"Theme","value":"Green"}]}' : ',{"trait_type":"Theme","value":"White"}]}'
        );
    }

    /// @dev Theme -> green card? 1 = white, 2 = green, anything else = default (green iff rare).
    function _green(bool rare, uint8 theme) internal pure returns (bool) {
        return theme == THEME_GREEN || (theme != THEME_WHITE && rare);
    }

    function _attributes(string calldata name, bool rare, bool reserved) internal pure returns (string memory) {
        return string.concat(
            '","attributes":[{"trait_type":"Length","display_type":"number","value":',
            bytes(name).length.toString(),
            '},{"trait_type":"Characters","value":"',
            _kind(name),
            '"},{"trait_type":"Rarity","value":"',
            rare ? "Rare" : "Standard",
            '"},{"trait_type":"Short name","value":"',
            rare ? "Yes" : "No",
            '"},{"trait_type":"Reserved","value":"',
            reserved ? "Yes" : "No",
            '"}' // the Theme trait and the closing "]}" are appended by json()
        );
    }

    /// @notice "Letters", "Numbers" or "Mixed" (anything with "_" or both letters and digits).
    function _kind(string calldata name) internal pure returns (string memory) {
        bytes calldata b = bytes(name);
        bool l;
        bool d;
        bool u;
        for (uint256 i; i < b.length; ++i) {
            if (b[i] >= 0x61) l = true;
            else if (b[i] == 0x5f) u = true;
            else d = true;
        }
        if (u || (l && d)) return "Mixed";
        return l ? "Letters" : "Numbers";
    }

    /// @dev Defence in depth: WiflyNames already validates, but this contract is public.
    function _check(string calldata name) internal pure {
        bytes calldata b = bytes(name);
        if (b.length == 0 || b.length > 32) revert BadName();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f)) revert BadName();
        }
    }

    // ================================================================ ART
    // 1000 x 1000 card; base attribute values are the final state for non-SMIL renderers.

    uint256 internal constant SIDE = 92; // name left edge
    uint256 internal constant MAX_W = 808; // name.wif width budget
    uint256 internal constant MAX_SIZE = 210; // name font size cap, px per em
    uint256 internal constant SUFFIX_MIN = 4400; // ".wif" floor, px * 100
    string internal constant WHITE = "#FFFFFF";

    /// @notice The raw SVG with the default theme.
    function svg(string calldata name, bool rare, bool reserved) public view returns (string memory) {
        return svg(name, rare, reserved, 0);
    }

    /// @notice The raw SVG. `theme`: 0 = default, 1 = white, 2 = green.
    function svg(string calldata name, bool rare, bool reserved, uint8 theme) public view returns (string memory) {
        _check(name);
        return _svg(name, rare, reserved, _green(rare, theme));
    }

    /// @dev `green` = neon card (else white); `rare` / `reserved` only drive the pills.
    function _svg(string calldata name, bool rare, bool reserved, bool green) internal view returns (string memory) {
        // `used` = bitmask of glyph slots referenced by <use>; each is emitted once in <defs>
        (string memory nameArt, uint256 used) = _nameBlock(name, green, 0);
        string memory top;
        (top, used) = _header(rare, reserved, green, used);
        string memory footer;
        (footer, used) = _footer(name, green, used);
        return string.concat(_open(name, green, used), top, nameArt, footer, "</svg>");
    }

    /// @dev <svg> open, glyph + dot-grid defs, background, the peeking face (clipped) and the frame.
    function _open(string calldata name, bool green, uint256 used) internal view returns (string memory) {
        string memory bg = green ? NEON : WHITE;
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000"><title>',
            name,
            ".wif</title><defs>",
            _defs(green, used),
            '<rect width="1000" height="1000" fill="',
            bg,
            '"/><rect width="1000" height="1000" fill="url(#d)"/><g clip-path="url(#f)"><g transform="translate(660 830) scale(7.6) translate(-50 -54)"><g>',
            _face(bg),
            '<animateTransform attributeName="transform" type="translate" values="0 0;0 -1.2;0 0" dur="4s" repeatCount="indefinite" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1"/></g></g></g><rect x="40" y="40" width="920" height="920" rx="48" fill="none" stroke="#110E08" stroke-width="3"/>'
        );
    }

    /// @dev Glyph outlines in use, the dot-grid pattern and the frame clip.
    function _defs(bool green, uint256 used) internal view returns (string memory) {
        return string.concat(
            _glyphDefs(used),
            green
                ? '<pattern id="d" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="16" cy="16" r="2.4" fill="#110E08" fill-opacity=".1"/>'
                : '<pattern id="d" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="16" cy="16" r="2.4" fill="#110E08" fill-opacity=".06"/>',
            '<animateTransform attributeName="patternTransform" type="translate" values="0 0;32 32" dur="8s" repeatCount="indefinite"/></pattern><clipPath id="f"><rect x="40" y="40" width="920" height="920" rx="48"/></clipPath></defs>'
        );
    }

    /// @dev "name.wif" sized to fit MAX_W, with ".wif" in grey on the same baseline.
    function _nameBlock(string calldata name, bool green, uint256 used) internal view returns (string memory out, uint256) {
        (uint256 s5,,) = _fit(name);
        uint256 base = 230 + (s5 * 7) / 1000; // 230 + 0.7 * size
        (out, used) = _text(name, SIDE, base, s5, INK, INK, false, used);
        string memory suffix;
        (suffix, used) = _suffix(name, green, base, used);
        return (
            string.concat(
                "<g>",
                out,
                suffix,
                '<animateTransform attributeName="transform" type="translate" values="0 36;0 0" dur=".9s" calcMode="spline" keySplines=".2 .8 .2 1" fill="freeze"/><animate attributeName="opacity" values="0;1" dur=".6s" fill="freeze"/></g>'
            ),
            used
        );
    }

    /// @dev The grey ".wif" run (split out for stack depth).
    function _suffix(string calldata name, bool green, uint256 base, uint256 used) internal view returns (string memory, uint256) {
        (, uint256 ss, uint256 sx) = _fit(name);
        return _text(".wif", sx, base, ss, green ? MUTED : SUBTLE, green ? MUTED : SUBTLE, false, used);
    }

    /// @notice Name layout: name and ".wif" font sizes (px * 100) and the x where ".wif" starts.
    function nameFit(string calldata name) external view returns (uint256 s5, uint256 ss, uint256 sx) {
        return _fit(name);
    }

    /// @dev ".wif" is 0.6x the name (min SUFFIX_MIN); both fit MAX_W, name capped at MAX_SIZE.
    function _fit(string calldata name) internal view returns (uint256 s5, uint256 ss, uint256 sx) {
        (uint256 wn,) = glyphs.layout(name);
        (uint256 ws,) = glyphs.layout(".wif");
        s5 = MAX_SIZE * 100; // = scale * 1e5
        if ((10 * wn + 6 * ws) * s5 > MAX_W * 1e6) s5 = (MAX_W * 1e6) / (10 * wn + 6 * ws);
        ss = (s5 * 6) / 10;
        if (ss < SUFFIX_MIN) {
            ss = SUFFIX_MIN;
            s5 = (MAX_W * 1e5 - ws * ss) / wn; // give the name what is left
        }
        sx = SIDE + (wn * s5) / 1e5 - (s5 * 40) / 1e5; // tuck ".wif" in by 0.04 em
    }

    /// @dev Top row: "wifly name" label and the rare/reserved pills.
    function _header(bool rare, bool reserved, bool green, uint256 used) internal view returns (string memory out, uint256) {
        string memory part;
        (out, used) = _text("wifly", 96, 140, 4400, INK, INK, false, used);
        (uint256 w,) = glyphs.layout("wifly ");
        (part, used) = _text("name", 96 + (w * 44) / 1000, 140, 4400, green ? INK : SUBTLE, green ? INK : SUBTLE, false, used);
        out = string.concat(out, part);
        uint256 right = 904;
        if (rare) {
            (part, used, right) = _pill("rare", right, INK, NEON, used);
            out = string.concat(out, part);
            right -= 12;
        }
        if (reserved) {
            (part, used,) = _pill("reserved", right, green ? WHITE : "#EFECE5", INK, used);
            out = string.concat(out, part);
        }
        return (out, used);
    }

    /// @dev Bottom left: length class and short token id.
    function _footer(string calldata name, bool green, uint256 used) internal view returns (string memory out, uint256) {
        bytes1 k0 = bytes(_kind(name))[0];
        string memory k = k0 == "L" ? " letters" : k0 == "N" ? " digits" : " chars";
        string memory part;
        (out, used) = _text(string.concat(bytes(name).length.toString(), k), 96, 868, 3000, green ? INK : MUTED, green ? INK : MUTED, false, used);
        (part, used) = _text(_shortId(name), 96, 912, 3000, green ? MUTED : SUBTLE, green ? MUTED : SUBTLE, false, used);
        return (string.concat(out, part), used);
    }

    /// @dev Short token id: "0x" + first 4 + ".." + last 4 hex digits.
    function _shortId(string calldata name) internal pure returns (string memory) {
        bytes memory h = bytes(uint256(keccak256(bytes(name))).toHexString(32));
        bytes memory o = new bytes(12);
        for (uint256 i; i < 6; ++i) {
            o[i] = h[i];
        }
        o[6] = ".";
        o[7] = ".";
        for (uint256 i; i < 4; ++i) {
            o[8 + i] = h[62 + i];
        }
        return string(o);
    }

    /// @dev The animated Wifly face; eyes and mouth in `feat`.
    function _face(string memory feat) internal pure returns (string memory) {
        string memory a = string.concat(F0, INK, F1, feat);
        return string.concat(a, F2, feat, F3);
    }

    string internal constant F0 =
        '<g transform="translate(50 92)"><g><animateTransform attributeName="transform" type="scale" dur="4s" repeatCount="indefinite" calcMode="spline" keyTimes="0;.67;.695;.735;.775;.805;1" keySplines=".65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1" values="1 1;1 1;1.07 .9;.97 1.045;1.005 .99;1 1;1 1"/><g transform="translate(-50 -92)"><path d="M50 12C74.1 12 93 31 93 55S76.5 92 50 92 7 79.5 7 55 25.9 12 50 12Z" fill="';
    string internal constant F1 =
        '"/><g fill="';
    string internal constant F2 =
        '"><g><animateTransform attributeName="transform" type="translate" dur="4s" repeatCount="indefinite" calcMode="spline" keyTimes="0;.0625;.125;.225;.2875;.375;.43;.5125;.555;.625;.7;.78;1" keySplines=".65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1" values="0 0;0 0;-5.6 .6;-5.6 .6;5.6 .6;5.6 .6;0 0;0 0;0 -4.6;0 -4.6;0 -2.9;0 0;0 0"/><rect x="32" y="32.8" width="11" height="18.5" rx="5.5"><animate attributeName="y" dur="4s" repeatCount="indefinite" calcMode="spline" keyTimes="0;.45;.4675;.495;.71;.75;.875;.975;1" keySplines=".65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1" values="32.8;32.8;41.3;32.8;32.8;35.2;35.2;32.8;32.8"/><animate attributeName="height" dur="4s" repeatCount="indefinite" calcMode="spline" keyTimes="0;.45;.4675;.495;.71;.75;.875;.975;1" keySplines=".65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1" values="18.5;18.5;1.5;18.5;18.5;14.8;14.8;18.5;18.5"/></rect><rect x="57" y="32.8" width="11" height="18.5" rx="5.5"><animate attributeName="y" dur="4s" repeatCount="indefinite" calcMode="spline" keyTimes="0;.45;.4675;.495;.71;.75;.875;.975;1" keySplines=".65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1" values="32.8;32.8;41.3;32.8;32.8;35.2;35.2;32.8;32.8"/><animate attributeName="height" dur="4s" repeatCount="indefinite" calcMode="spline" keyTimes="0;.45;.4675;.495;.71;.75;.875;.975;1" keySplines=".65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1" values="18.5;18.5;1.5;18.5;18.5;14.8;14.8;18.5;18.5"/></rect></g></g><path d="M32.5 60.5C33.1 67.5 35.7 69 41 69 46.4 69 49.6 65.8 50 62 50.4 65.8 53.6 69 59 69 64.3 69 66.9 67.5 67.5 60.5" fill="none" stroke="';
    string internal constant F3 =
        '" stroke-width="6.6" stroke-linecap="round" stroke-linejoin="round"><animate attributeName="d" dur="4s" repeatCount="indefinite" calcMode="spline" keyTimes="0;.6375;.67;.71;.75;.875;.975;1" keySplines=".65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1" values="M32.5 60.5C33.1 67.5 35.7 69 41 69 46.4 69 49.6 65.8 50 62 50.4 65.8 53.6 69 59 69 64.3 69 66.9 67.5 67.5 60.5;M32.5 60.5C33.1 67.5 35.7 69 41 69 46.4 69 49.6 65.8 50 62 50.4 65.8 53.6 69 59 69 64.3 69 66.9 67.5 67.5 60.5;M50 59.9C46.4 59.9 43.4 62.9 43.4 66.5 43.4 70.1 46.4 73.1 50 73.1 53.6 73.1 56.6 70.1 56.6 66.5 56.6 62.9 53.6 59.9 50 59.9;M50 59.9C46.4 59.9 43.4 62.9 43.4 66.5 43.4 70.1 46.4 73.1 50 73.1 53.6 73.1 56.6 70.1 56.6 66.5 56.6 62.9 53.6 59.9 50 59.9;M29.5 58.5C30.1 70 33.4 72.5 39.8 72.5 45.9 72.5 49.6 68.4 50 63.4 50.4 68.4 54.1 72.5 60.2 72.5 66.6 72.5 69.9 70 70.5 58.5;M29.5 58.5C30.1 70 33.4 72.5 39.8 72.5 45.9 72.5 49.6 68.4 50 63.4 50.4 68.4 54.1 72.5 60.2 72.5 66.6 72.5 69.9 70 70.5 58.5;M32.5 60.5C33.1 67.5 35.7 69 41 69 46.4 69 49.6 65.8 50 62 50.4 65.8 53.6 69 59 69 64.3 69 66.9 67.5 67.5 60.5;M32.5 60.5C33.1 67.5 35.7 69 41 69 46.4 69 49.6 65.8 50 62 50.4 65.8 53.6 69 59 69 64.3 69 66.9 67.5 67.5 60.5"/><animate attributeName="stroke-width" dur="4s" repeatCount="indefinite" calcMode="spline" keyTimes="0;.6375;.67;.71;.75;.875;.975;1" keySplines=".65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1;.65 0 .35 1" values="6.6;6.6;6.4;6.4;7.2;7.2;6.6;6.6"/></path></g></g></g>';

    /// @dev A rounded label pill ending at `right`; returns its left edge.
    function _pill(string memory label, uint256 right, string memory bg, string memory fg, uint256 used)
        internal
        view
        returns (string memory out, uint256 usedOut, uint256 left)
    {
        (uint256 w,) = glyphs.layout(label);
        uint256 tw = (w * 30) / 1000; // 30 px text
        left = right - tw - 48;
        string memory t;
        (t, usedOut) = _text(label, left + 24, 137, 3000, fg, fg, false, used);
        out = string.concat(
            '<rect x="',
            left.toString(),
            '" y="98" width="',
            (tw + 48).toString(),
            '" height="56" rx="28" fill="',
            bg,
            '"/>',
            t
        );
    }

    // ================================================================ text engine
    /// @dev Sets `s` in WIF Par, one <use> per glyph; `s5` = font size px * 100.
    function _text(
        string memory s,
        uint256 x,
        uint256 y,
        uint256 s5,
        string memory fill,
        string memory firstFill,
        bool alignRight,
        uint256 used
    ) internal view returns (string memory out, uint256) {
        (uint256 w, uint256[] memory xs) = glyphs.layout(s);
        if (alignRight) x -= (w * s5) / 1e5;
        out = string.concat('<g transform="translate(', x.toString(), " ", y.toString(), ") scale(", _fix5(s5), ')" fill="', fill, '">');
        bytes memory b = bytes(s);
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == 0x20) continue;
            uint256 slot = _slot(b[i]);
            used |= 1 << slot;
            out = string.concat(
                out,
                '<use href="#g',
                slot.toString(),
                '" x="',
                xs[i].toString(),
                i == 0 && keccak256(bytes(firstFill)) != keccak256(bytes(fill))
                    ? string.concat('" fill="', firstFill, '"/>')
                    : '"/>'
            );
        }
        return (string.concat(out, "</g>"), used);
    }

    function _glyphDefs(uint256 used) internal view returns (string memory out) {
        bytes memory cs = "abcdefghijklmnopqrstuvwxyz0123456789_@.";
        for (uint256 slot; slot < 39; ++slot) {
            if (used & (1 << slot) == 0) continue;
            out = string.concat(out, '<path id="g', slot.toString(), '" d="', glyphs.path(cs[slot]), '"/>');
        }
    }

    function _slot(bytes1 c) internal pure returns (uint256) {
        if (c >= 0x61) return uint8(c) - 0x61;
        if (c >= 0x30 && c <= 0x39) return uint8(c) - 0x30 + 26;
        if (c == 0x2e) return 38; // "."
        return c == 0x5f ? 36 : 37; // "_" or "@"
    }

    /// @dev 25000 -> "0.25000"
    function _fix5(uint256 v) internal pure returns (string memory) {
        string memory frac = (v % 1e5 + 1e5).toString(); // "1xxxxx"
        bytes memory f = bytes(frac);
        bytes memory d = new bytes(5);
        for (uint256 i; i < 5; ++i) {
            d[i] = f[i + 1];
        }
        return string.concat((v / 1e5).toString(), ".", string(d));
    }
}
