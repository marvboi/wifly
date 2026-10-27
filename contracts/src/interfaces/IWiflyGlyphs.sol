// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice On-chain WIF Par outlines (see render/WiflyGlyphs.sol).
interface IWiflyGlyphs {
    function path(bytes1 c) external pure returns (string memory);
    function advance(bytes1 c) external pure returns (uint256);
    function kern(bytes1 a, bytes1 b) external pure returns (uint256);
    function layout(string calldata text) external pure returns (uint256 width, uint256[] memory xs);
}
