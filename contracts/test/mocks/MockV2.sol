// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Wifly} from "../../src/Wifly.sol";
import {WiflyNames} from "../../src/WiflyNames.sol";
import {WiflyBadges} from "../../src/WiflyBadges.sol";
import {WiflyDCA} from "../../src/WiflyDCA.sol";
import {WiflyGlyphs} from "../../src/render/WiflyGlyphs.sol";

/// @dev V2 mocks for upgrade tests: same storage, one new function (and a reinitializer to prove it runs once).
contract WiflyV2 is Wifly {
    function version() external pure returns (string memory) {
        return "v2";
    }
}

contract WiflyNamesV2 is WiflyNames {
    function version() external pure returns (string memory) {
        return "v2";
    }
}

contract WiflyBadgesV2 is WiflyBadges {
    function version() external pure returns (string memory) {
        return "v2";
    }
}

contract WiflyDCAV2 is WiflyDCA {
    uint256 public migrated;

    function initializeV2() external reinitializer(2) {
        migrated = 42;
    }

    function version() external pure returns (string memory) {
        return "v2";
    }
}

contract WiflyGlyphsV2 is WiflyGlyphs {
    function version() external pure returns (string memory) {
        return "v2";
    }
}

/// @dev Not UUPS (no proxiableUUID): upgrading to it must be rejected so a proxy can't be bricked by mistake.
contract NotUUPS {
    function version() external pure returns (string memory) {
        return "bad";
    }
}
