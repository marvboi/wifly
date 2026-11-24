// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Global Dollar (USDG): 6 decimals on Robinhood Chain.
contract MockUSDG is ERC20 {
    uint8 private immutable _dec;

    constructor() ERC20("Global Dollar", "USDG") {
        _dec = 6;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}