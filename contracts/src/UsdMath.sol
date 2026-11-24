// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev USDG on Robinhood Chain uses 6 decimals; WIF uses 18.
library UsdMath {
    uint256 internal constant WIF_UNIT = 1e18;
    uint256 internal constant USDG_UNIT = 1e6;

    /// @notice USDG smallest-units (6 decimals) required for a WIF wei amount at `usdgPerWif`.
    /// @dev `usdgPerWif` is micro-USDG per 1e18 WIF wei (default 1e6 = 1:1 dollar per token).
    function usdgForWif(uint256 wifWei, uint256 usdgPerWif) internal pure returns (uint256) {
        if (usdgPerWif == 0) return 0;
        return (wifWei * usdgPerWif) / WIF_UNIT;
    }

    /// @notice WIF wei equivalent of `usdgAmount` at `usdgPerWif`.
    function wifFromUsdg(uint256 usdgAmount, uint256 usdgPerWif) internal pure returns (uint256) {
        if (usdgPerWif == 0) return 0;
        return (usdgAmount * WIF_UNIT) / usdgPerWif;
    }
}