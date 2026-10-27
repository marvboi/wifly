// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @dev Ownerless ERC20 with burn(uint256), mirroring the deployed WIF interface. mint is test-only.
contract MockWIF is ERC20, ERC20Burnable {
    constructor() ERC20("World is Flat", "WIF") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Token without burn(), for the transfer-to-dead fallback.
contract MockNoBurn is ERC20 {
    constructor() ERC20("NoBurn", "NB") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
