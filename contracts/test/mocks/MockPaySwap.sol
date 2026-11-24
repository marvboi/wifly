// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWifToWifSwap} from "../../src/interfaces/IWiflyPayments.sol";

/// @dev 1 wei ETH or 1 unit of any token -> 1 wei WIF from a pre-funded pool.
contract MockPaySwap is IWifToWifSwap {
    using SafeERC20 for IERC20;

    IERC20 public wif;
    /// @dev micro-USDG per 1e18 WIF wei; 0 = legacy test parity (1 USDG unit → 1 WIF).
    uint256 public usdgPerWif;

    constructor(IERC20 wif_) {
        wif = wif_;
    }

    function setUsdgPerWif(uint256 rate) external {
        usdgPerWif = rate;
    }

    function swapEthForWif(uint256) external payable returns (uint256 wifOut) {
        wifOut = msg.value;
        wif.transfer(msg.sender, wifOut);
    }

    function swapTokenForWif(address token, uint256 amount, uint256) external returns (uint256 wifOut) {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            if (d == 6 && usdgPerWif != 0) {
                wifOut = (amount * 1e18) / usdgPerWif;
            } else {
                // USDG 6 decimals → 18: legacy 1:1 token count in tests when rate unset.
                wifOut = d < 18 ? amount * 10 ** (18 - d) : amount;
            }
        } catch {
            wifOut = amount;
        }
        wif.transfer(msg.sender, wifOut);
    }

    function seed(uint256 amt) external {
        wif.transferFrom(msg.sender, address(this), amt);
    }
}