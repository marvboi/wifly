// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Wifly surface for the payments router.
interface IWiflyPay {
    function subscribePlan(address creator, uint8 tier, uint8 plan) external;
    function takeTopSpot(bytes32 postId, uint256 amount) external;
    function quotePlatformSplit(uint256 amount) external view returns (uint256 potPart, uint256 burnPart, uint256 treasuryPart);
    function wif() external view returns (address);
    function fundPot(uint256 amount) external;
}

/// @notice Optional: swap inbound ETH or USDG to WIF; 0 = router must hold WIF.
interface IWifToWifSwap {
    function swapEthForWif(uint256 minOut) external payable returns (uint256 wifOut);
    function swapTokenForWif(address token, uint256 amount, uint256 minOut) external returns (uint256 wifOut);
}