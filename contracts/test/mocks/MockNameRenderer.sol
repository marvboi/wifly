// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWiflyNameRenderer} from "../../src/interfaces/IWiflyNameRenderer.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @dev Echoes every argument back so tests can see exactly what WiflyNames passed in.
contract MockNameRenderer is IWiflyNameRenderer {
    using Strings for uint256;

    function tokenURI(uint256 tokenId, string calldata name, bool rare, bool reserved, uint8 theme)
        external
        pure
        returns (string memory)
    {
        return string.concat(
            "mock:",
            tokenId.toHexString(),
            ":",
            name,
            ":",
            rare ? "1" : "0",
            ":",
            reserved ? "1" : "0",
            ":",
            uint256(theme).toString()
        );
    }
}
