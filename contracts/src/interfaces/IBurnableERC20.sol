// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice $WIF on Robinhood Chain exposes OpenZeppelin-style ERC20Burnable `burn(uint256)` and `burnFrom`.
interface IBurnableERC20 is IERC20 {
    function burn(uint256 value) external;

    function burnFrom(address account, uint256 value) external;
}
