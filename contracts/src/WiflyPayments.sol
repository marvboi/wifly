// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IBurnableERC20} from "./interfaces/IBurnableERC20.sol";
import {IWifToWifSwap} from "./interfaces/IWiflyPayments.sol";
import {IWiflyPot} from "./interfaces/IWiflyPot.sol";
import {Wifly} from "./Wifly.sol";
import {WiflyNames} from "./WiflyNames.sol";

/// @title WiflyPayments
/// @notice Checkout in WIF, USDG or ETH for Plus, name claims and post boosts (Top Spot).
contract WiflyPayments is
    Initializable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    uint8 public constant MONTHLY = 0;
    uint8 public constant YEARLY = 1;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    Wifly public wifly;
    WiflyNames public names;
    IERC20 public wif;
    IERC20 public usdg;
    bool public useBurnFunction;
    address public plusCreator;
    uint8 public plusTier;
    IWifToWifSwap public swapRouter;
    address public treasury;
    uint256 public pendingWifBurn;

    uint256[44] private __gap;

    event UsdgSet(address token);
    event SwapRouterSet(address router);
    event PlusPaid(address indexed payer, uint8 plan, address payToken, uint256 wifAmount);
    event NamePaid(address indexed payer, string name, address indexed to, address payToken, uint256 wifAmount);
    event BoostPaid(address indexed payer, bytes32 postId, address payToken, uint256 wifAmount);
    event BurnQueued(uint256 amount);
    event PendingBurned(uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error BadPlan();
    error SwapFailed();
    error InsufficientWif();
    error TierDisabled();

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address wifly_,
        address names_,
        address wif_,
        bool useBurn_,
        address plusCreator_,
        address treasury_,
        address owner_
    ) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        if (wifly_ == address(0) || names_ == address(0) || wif_ == address(0) || plusCreator_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        wifly = Wifly(wifly_);
        names = WiflyNames(names_);
        wif = IERC20(wif_);
        useBurnFunction = useBurn_;
        plusCreator = plusCreator_;
        treasury = treasury_;
        plusTier = 0;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setUsdg(address token) external onlyOwner {
        usdg = IERC20(token);
        emit UsdgSet(token);
    }

    function setSwapRouter(address router) external onlyOwner {
        swapRouter = IWifToWifSwap(router);
        emit SwapRouterSet(router);
    }

    function payPlusWif(uint8 plan) external nonReentrant whenNotPaused {
        uint256 price = _plusPrice(plan);
        wif.safeTransferFrom(msg.sender, address(this), price);
        _finishPlus(msg.sender, plan, price);
    }

    function payPlusEth(uint8 plan) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        uint256 price = _plusPrice(plan);
        uint256 got = _swapEthForWif(msg.value);
        if (got < price) revert InsufficientWif();
        _finishPlus(msg.sender, plan, price);
        _refundWif(got - price);
        _refundEth();
    }

    function payPlusUsdg(uint8 plan, uint256 usdgAmount) external nonReentrant whenNotPaused {
        if (usdgAmount == 0) revert ZeroAmount();
        if (address(usdg) == address(0)) revert ZeroAddress();
        uint256 price = _plusPrice(plan);
        usdg.safeTransferFrom(msg.sender, address(this), usdgAmount);
        uint256 got = _swapTokenForWif(address(usdg), usdgAmount);
        if (got < price) revert InsufficientWif();
        _finishPlus(msg.sender, plan, price);
        _refundWif(got - price);
    }

    function payNameWif(string calldata name, address to) external nonReentrant whenNotPaused {
        uint256 fee = names.claimFeeOf(name);
        if (fee == 0) revert ZeroAmount();
        wif.safeTransferFrom(msg.sender, address(this), fee);
        _payNameClaim(name, to, fee);
    }

    function payNameEth(string calldata name, address to) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        uint256 fee = names.claimFeeOf(name);
        if (fee == 0) revert ZeroAmount();
        uint256 got = _swapEthForWif(msg.value);
        if (got < fee) revert InsufficientWif();
        _payNameClaim(name, to, fee);
        _refundWif(got - fee);
        _refundEth();
    }

    function payNameUsdg(string calldata name, address to, uint256 usdgAmount) external nonReentrant whenNotPaused {
        if (usdgAmount == 0) revert ZeroAmount();
        if (address(usdg) == address(0)) revert ZeroAddress();
        uint256 fee = names.claimFeeOf(name);
        if (fee == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), usdgAmount);
        uint256 got = _swapTokenForWif(address(usdg), usdgAmount);
        if (got < fee) revert InsufficientWif();
        _payNameClaim(name, to, fee);
        _refundWif(got - fee);
    }

    function payBoostWif(bytes32 postId, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        wif.safeTransferFrom(msg.sender, address(this), amount);
        _finishBoost(msg.sender, postId, amount);
    }

    function payBoostEth(bytes32 postId) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        uint256 got = _swapEthForWif(msg.value);
        if (got == 0) revert InsufficientWif();
        _finishBoost(msg.sender, postId, got);
        _refundEth();
    }

    function payBoostUsdg(bytes32 postId, uint256 usdgAmount) external nonReentrant whenNotPaused {
        if (usdgAmount == 0) revert ZeroAmount();
        if (address(usdg) == address(0)) revert ZeroAddress();
        usdg.safeTransferFrom(msg.sender, address(this), usdgAmount);
        uint256 got = _swapTokenForWif(address(usdg), usdgAmount);
        if (got == 0) revert InsufficientWif();
        _finishBoost(msg.sender, postId, got);
    }

    function flushPendingBurn() external nonReentrant {
        uint256 amt = pendingWifBurn;
        if (amt == 0) return;
        if (wif.balanceOf(address(this)) < amt) revert InsufficientWif();
        pendingWifBurn = 0;
        _burnWif(amt);
        emit PendingBurned(amt);
    }

    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "eth");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _plusPrice(uint8 plan) internal view returns (uint256 price) {
        if (plan > YEARLY) revert BadPlan();
        uint256[3] memory monthly = wifly.tierPrices(plusCreator);
        uint256[3] memory yearly = wifly.yearlyPrices(plusCreator);
        price = plan == YEARLY ? yearly[plusTier] : monthly[plusTier];
        if (price == 0) revert TierDisabled();
    }

    function _finishPlus(address payer, uint8 plan, uint256 price) internal {
        wif.forceApprove(address(wifly), price);
        wifly.subscribePlanPaidFor(payer, plusCreator, plusTier, plan);
        emit PlusPaid(payer, plan, address(wif), price);
    }

    function _payNameClaim(string calldata name, address to, uint256 fee) internal {
        address beneficiary = to == address(0) ? msg.sender : to;
        (uint256 toTreasury, uint256 toPot) = names.quoteClaimSplit(fee);
        if (toTreasury != 0) wif.safeTransfer(treasury, toTreasury);
        IWiflyPot pot = names.pot();
        if (toPot != 0) {
            if (address(pot) != address(0)) {
                wif.forceApprove(address(pot), toPot);
                pot.fundPot(toPot);
            } else {
                wif.safeTransfer(treasury, toPot);
            }
        }
        names.claimFor(name, beneficiary);
        emit NamePaid(msg.sender, name, beneficiary, address(wif), fee);
    }

    function _finishBoost(address payer, bytes32 postId, uint256 amount) internal {
        wif.forceApprove(address(wifly), amount);
        wifly.takeTopSpotPaidFor(payer, postId, amount);
        emit BoostPaid(payer, postId, address(wif), amount);
    }

    function _swapEthForWif(uint256 ethIn) internal returns (uint256 wifOut) {
        if (address(swapRouter) == address(0)) revert SwapFailed();
        uint256 before = wif.balanceOf(address(this));
        wifOut = swapRouter.swapEthForWif{value: ethIn}(0);
        if (wifOut == 0) wifOut = wif.balanceOf(address(this)) - before;
    }

    function _swapTokenForWif(address token, uint256 amount) internal returns (uint256 wifOut) {
        if (address(swapRouter) == address(0)) revert SwapFailed();
        IERC20(token).forceApprove(address(swapRouter), amount);
        uint256 before = wif.balanceOf(address(this));
        wifOut = swapRouter.swapTokenForWif(token, amount, 0);
        if (wifOut == 0) wifOut = wif.balanceOf(address(this)) - before;
    }

    function _refundWif(uint256 amount) internal {
        if (amount != 0) wif.safeTransfer(msg.sender, amount);
    }

    function _refundEth() internal {
        uint256 bal = address(this).balance;
        if (bal != 0) {
            (bool ok,) = msg.sender.call{value: bal}("");
            require(ok, "eth");
        }
    }

    function _burnWif(uint256 amount) internal {
        if (amount == 0) return;
        if (useBurnFunction) IBurnableERC20(address(wif)).burn(amount);
        else wif.safeTransfer(DEAD, amount);
    }

    receive() external payable {}
}