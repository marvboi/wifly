// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWifToWifSwap} from "../../src/interfaces/IWiflyPayments.sol";

/// @dev 1 wei ETH or 1 unit of any token -> 1 wei WIF from a pre-funded pool.
contract MockPaySwap is IWifToWifSwap {
    using SafeERC20 for IERC20;

    IERC20 public wif;

    constructor(IERC20 wif_) {
        wif = wif_;
    }

    function swapEthForWif(uint256) external payable returns (uint256 wifOut) {
        wifOut = msg.value;
        wif.transfer(msg.sender, wifOut);
    }

    function swapTokenForWif(address token, uint256 amount, uint256) external returns (uint256 wifOut) {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        wifOut = amount;
        wif.transfer(msg.sender, wifOut);
    }

    function seed(uint256 amt) external {
        wif.transferFrom(msg.sender, address(this), amt);
    }
}