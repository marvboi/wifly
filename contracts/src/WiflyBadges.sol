// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IBurnableERC20} from "./interfaces/IBurnableERC20.sol";

/// @title WiflyBadges
/// @notice Burn $WIF to earn soulbound ERC-1155 badges at cumulative burn thresholds.
contract WiflyBadges is
    Initializable,
    ERC1155Upgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    uint256 public constant MAX_LEVELS = 32;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public wif;
    bool public useBurnFunction;

    uint256[] public thresholds; // badge id => cumulative WIF burned needed
    mapping(address => uint256) public burnedBy;
    mapping(address => uint256) public levelsEarned; // badges 0..levelsEarned-1 are held
    uint256 public totalBurned;

    /// @dev Reserved storage for future upgrades.
    uint256[50] private __gap;

    event BurnedForBadges(address indexed user, uint256 amount, uint256 totalBurnedByUser);
    event BadgeEarned(address indexed user, uint256 indexed badgeId, uint256 threshold);
    event LevelAdded(uint256 indexed badgeId, uint256 threshold);
    event URISet(string uri);

    error ZeroAmount();
    error ZeroAddress();
    error Soulbound();
    error BadThreshold();
    error TooManyLevels();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Proxy initializer.
    function initialize(
        address wif_,
        bool useBurnFunction_,
        address owner_,
        string calldata uri_,
        uint256[] calldata thresholds_
    ) external initializer {
        __ERC1155_init(uri_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        if (wif_ == address(0)) revert ZeroAddress();
        wif = IERC20(wif_);
        useBurnFunction = useBurnFunction_;
        for (uint256 i; i < thresholds_.length; ++i) {
            _addLevel(thresholds_[i]);
        }
    }

    /// @dev UUPS: only the owner can upgrade.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Burn `amount` of your WIF (approve this contract first) and receive every badge you now qualify for.
    function burn(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 total = burnedBy[msg.sender] + amount;
        burnedBy[msg.sender] = total;
        totalBurned += amount;
        emit BurnedForBadges(msg.sender, amount, total);
        if (useBurnFunction) IBurnableERC20(address(wif)).burnFrom(msg.sender, amount);
        else wif.safeTransferFrom(msg.sender, DEAD, amount);
        _award(msg.sender);
    }

    /// @notice Award any badges `user` qualifies for but doesn't hold yet (e.g. after a new level is added).
    function claim(address user) external nonReentrant returns (uint256 newBadges) {
        return _award(user);
    }

    function addLevel(uint256 threshold) external onlyOwner {
        _addLevel(threshold);
    }

    function setURI(string calldata uri_) external onlyOwner {
        _setURI(uri_);
        emit URISet(uri_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // =================================================================== views
    function levelCount() external view returns (uint256) {
        return thresholds.length;
    }

    function allThresholds() external view returns (uint256[] memory) {
        return thresholds;
    }

    /// @notice WIF still to burn for the next badge (0 if every level is earned or claimable now).
    function toNextBadge(address user) external view returns (uint256 badgeId, uint256 remaining) {
        uint256 b = burnedBy[user];
        for (uint256 i; i < thresholds.length; ++i) {
            if (b < thresholds[i]) return (i, thresholds[i] - b);
        }
        return (thresholds.length, 0);
    }

    // =================================================================== soulbound
    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0)) revert Soulbound(); // no transfers, no burns: mint only
        super._update(from, to, ids, values);
    }

    // =================================================================== internal
    function _addLevel(uint256 threshold) internal {
        uint256 n = thresholds.length;
        if (n >= MAX_LEVELS) revert TooManyLevels();
        if (threshold == 0 || (n != 0 && threshold <= thresholds[n - 1])) revert BadThreshold();
        thresholds.push(threshold);
        emit LevelAdded(n, threshold);
    }

    function _award(address user) internal returns (uint256 newBadges) {
        uint256 b = burnedBy[user];
        uint256 i = levelsEarned[user];
        uint256 n = thresholds.length;
        while (i < n && b >= thresholds[i]) {
            emit BadgeEarned(user, i, thresholds[i]);
            // skip the receiver check so any wallet can earn badges
            uint256[] memory ids = new uint256[](1);
            uint256[] memory values = new uint256[](1);
            ids[0] = i;
            values[0] = 1;
            _update(address(0), user, ids, values);
            ++i;
            ++newBadges;
        }
        levelsEarned[user] = i;
    }
}
