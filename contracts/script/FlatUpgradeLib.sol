// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Wifly} from "../src/Wifly.sol";
import {WiflyNames} from "../src/WiflyNames.sol";

/// @notice Shared flat-upgrade logic for UpgradeFlat.s.sol and fork rehearsals.
library FlatUpgradeLib {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Proxy owner / treasury from deploy records; default Plus creator per Marv.
    address internal constant DEFAULT_TREASURY = 0x8E5f84738C0fb29670F370F73E53BD234CEfeF21;
    address internal constant USDG_ROBINHOOD = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    uint256 internal constant FEE_5 = 200e18;
    uint256 internal constant FEE_4 = 2_000e18;
    uint256 internal constant FEE_3 = 4_000e18;
    uint256 internal constant FEE_2 = 8_000e18;
    uint256 internal constant MIN_VOTE = 30e18;
    uint256 internal constant PLUS_MONTH = 3_000e18;
    uint256 internal constant PLUS_YEAR = 30_000e18;

    function implementation(address proxy) internal view returns (address) {
        return address(uint160(uint256(VM.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    function wiflyFlatDone(Wifly w) internal view returns (bool) {
        try w.feeSplitSet() returns (bool split) {
            try w.feeTreasuryBps() returns (uint16 treas) {
                try w.feeBurnBps() returns (uint16 burn) {
                    return split && treas == 2_000 && burn == 1_000;
                } catch {
                    return false;
                }
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    function wiflyV3Done(Wifly w) internal view returns (bool) {
        try w.usdg() returns (IERC20 usdg) {
            try w.minVoteAmount() returns (uint256 mv) {
                return address(usdg) == USDG_ROBINHOOD && mv == MIN_VOTE;
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    function wiflyV4Done(Wifly w) internal view returns (bool) {
        try w.plusCreator() returns (address pc) {
            if (pc == address(0)) return false;
            try w.tierPrices(pc) returns (uint256[3] memory months) {
                try w.yearlyPrices(pc) returns (uint256[3] memory yearly) {
                    return months[0] == PLUS_MONTH && yearly[0] == PLUS_YEAR;
                } catch {
                    return false;
                }
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    function namesV2Done(WiflyNames n) internal view returns (bool) {
        try n.claimFee() returns (uint256 fee5) {
            try n.shortClaimFee() returns (uint256 fee4) {
                try n.claimFee3() returns (uint256 fee3) {
                    try n.claimFee2() returns (uint256 fee2) {
                        return fee5 == FEE_5 && fee4 == FEE_4 && fee3 == FEE_3 && fee2 == FEE_2;
                    } catch {
                        return false;
                    }
                } catch {
                    return false;
                }
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    function namesV3Done(WiflyNames n) internal view returns (bool) {
        try n.usdg() returns (IERC20 usdg) {
            return address(usdg) == USDG_ROBINHOOD;
        } catch {
            return false;
        }
    }

    /// @dev Upgrades Wifly proxy to `impl` and runs any pending reinitializers (v2/v3/v4) in order.
    function upgradeWifly(Wifly w, address impl, address plusCreator) internal {
        if (!wiflyFlatDone(w)) {
            UUPSUpgradeable(address(w)).upgradeToAndCall(impl, abi.encodeCall(Wifly.initializeFlat, ()));
        } else if (implementation(address(w)) != impl) {
            UUPSUpgradeable(address(w)).upgradeToAndCall(impl, "");
        }
        if (!wiflyV3Done(w)) {
            UUPSUpgradeable(address(w)).upgradeToAndCall(impl, abi.encodeCall(Wifly.initializeV3, ()));
        }
        if (!wiflyV4Done(w)) {
            address creator = plusCreator == address(0) ? DEFAULT_TREASURY : plusCreator;
            UUPSUpgradeable(address(w)).upgradeToAndCall(impl, abi.encodeCall(Wifly.initializeV4, (creator)));
        } else if (implementation(address(w)) != impl) {
            UUPSUpgradeable(address(w)).upgradeToAndCall(impl, "");
        }
    }

    /// @dev Upgrades WiflyNames proxy to `impl` and runs initializeV2 / initializeV3 when still needed.
    function upgradeNames(WiflyNames n, address impl) internal {
        if (!namesV2Done(n)) {
            UUPSUpgradeable(address(n)).upgradeToAndCall(
                impl, abi.encodeCall(WiflyNames.initializeV2, (FEE_5, FEE_4, FEE_3, FEE_2))
            );
        } else if (implementation(address(n)) != impl) {
            UUPSUpgradeable(address(n)).upgradeToAndCall(impl, "");
        }
        if (!namesV3Done(n)) {
            UUPSUpgradeable(address(n)).upgradeToAndCall(impl, abi.encodeCall(WiflyNames.initializeV3, ()));
        } else if (implementation(address(n)) != impl) {
            UUPSUpgradeable(address(n)).upgradeToAndCall(impl, "");
        }
    }
}