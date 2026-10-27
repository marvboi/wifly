// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The part of Wifly that other contracts use to add WIF to the community pot.
interface IWiflyPot {
    /// @dev Pulls `amount` WIF from msg.sender (approve first) into Wifly's community pot.
    function fundPot(uint256 amount) external;
}
