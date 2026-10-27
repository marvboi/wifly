// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Art and metadata renderer for WiflyNames.
interface IWiflyNameRenderer {
    /// @param tokenId  the WiflyNames token id (keccak256 of the name)
    /// @param name     the bare label, already validated: 3-20 bytes of [a-z0-9_]; show it as `<name>.wif`
    /// @param rare     true for short (3-4 character) names
    /// @param reserved true if the name was minted with reserve()
    /// @param theme    the card theme the owner picked: 0 = default, 1 = white, 2 = green
    /// @return a full `data:application/json;base64,...` token URI with an on-chain SVG image
    function tokenURI(uint256 tokenId, string calldata name, bool rare, bool reserved, uint8 theme)
        external
        view
        returns (string memory);
}
