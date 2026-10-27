// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    PoolKey,
    ExactInputSingleParams,
    QuoteExactSingleParams,
    IUniversalRouter,
    IV4Quoter
} from "./interfaces/IUniswapV4Minimal.sol";

/// @title WiflyDCA
/// @notice Recurring ETH -> $WIF buys via Uniswap v4, triggered by allowlisted keepers; WIF goes straight to the plan owner.
contract WiflyDCA is
    Initializable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    uint32 public constant MIN_INTERVAL = 1 hours;
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000; // 10%
    uint256 public constant BPS = 10_000;

    uint8 internal constant V4_SWAP = 0x10; // Universal Router command
    uint8 internal constant SWAP_EXACT_IN_SINGLE = 0x06; // v4 router actions
    uint8 internal constant SETTLE_ALL = 0x0c;
    uint8 internal constant TAKE = 0x0e; // (currency, recipient, amount); amount 0 = OPEN_DELTA = full credit

    // ---------------------------------------------------------------- pool config

    IUniversalRouter public router;
    IV4Quoter public quoter;
    IERC20 public wif;
    address public hooks;
    uint24 public poolFee;
    int24 public tickSpacing;

    // ---------------------------------------------------------------- storage

    struct Plan {
        // slot 0
        address owner;
        uint40 startAt; // first buy allowed at/after this time
        uint40 lastBuyAt; // 0 = never bought
        uint16 maxSlippageBps; // 0 = no quote check (only allowed with a price floor)
        // slot 1
        uint128 balance; // ETH left in the plan (wei)
        uint128 amountPerBuy; // ETH swapped per buy (wei)
        // slot 2
        uint128 keeperTip; // ETH paid to the keeper per buy, on top of amountPerBuy (default 0)
        uint32 interval; // seconds between buys, >= MIN_INTERVAL
        uint32 maxBuys; // 0 = until the balance runs out
        uint32 buysDone;
        bool paused;
        bool cancelled;
        // slot 3
        uint256 minWifPerEth; // WIF wei per 1 ETH (1e18 wei); 0 = no floor
        // slot 4
        uint128 totalEthSpent;
        uint128 totalWifBought;
    }

    /// @notice Why a plan was not bought in a batch (also used in NotExecutable reverts).
    enum Skip {
        None,
        NoPlan,
        Cancelled,
        PlanPaused,
        Finished, // maxBuys reached
        NotDue,
        LowBalance, // balance < amountPerBuy + keeperTip
        BelowFloor, // minWifOut under the user's price floor
        QuoteFailed,
        TooMuchSlippage, // minWifOut under quote * (1 - maxSlippageBps)
        SwapFailed, // router reverted (e.g. output < minWifOut)
        ShortOutput // owner received less than minWifOut
    }

    struct PlanParams {
        uint128 amountPerBuy;
        uint32 interval;
        uint32 maxBuys;
        uint256 minWifPerEth;
        uint16 maxSlippageBps;
        uint128 keeperTip;
    }

    mapping(uint256 planId => Plan) internal _plans;
    mapping(address owner => uint256[]) internal _plansOf;
    mapping(address => bool) public isKeeper;
    uint256 public nextPlanId;
    uint256 public totalDeposits;

    /// @dev Reserved storage for future upgrades.
    uint256[50] private __gap;

    // ---------------------------------------------------------------- events

    event PlanCreated(
        uint256 indexed planId,
        address indexed owner,
        uint256 deposit,
        uint256 amountPerBuy,
        uint32 interval,
        uint32 maxBuys,
        uint256 minWifPerEth,
        uint16 maxSlippageBps,
        uint256 keeperTip,
        uint40 startAt
    );
    event PlanUpdated(
        uint256 indexed planId,
        uint256 amountPerBuy,
        uint32 interval,
        uint32 maxBuys,
        uint256 minWifPerEth,
        uint16 maxSlippageBps,
        uint256 keeperTip
    );
    event ToppedUp(uint256 indexed planId, uint256 amount, uint256 newBalance);
    event Withdrawn(uint256 indexed planId, address indexed to, uint256 amount, uint256 newBalance);
    event PlanPaused(uint256 indexed planId, bool paused);
    event PlanCancelled(uint256 indexed planId, uint256 refunded);
    event Bought(
        uint256 indexed planId,
        address indexed owner,
        address indexed keeper,
        uint256 ethIn,
        uint256 wifOut,
        uint256 keeperTip,
        uint32 buysDone,
        uint256 balanceLeft
    );
    event Skipped(uint256 indexed planId, Skip reason);
    event KeeperSet(address indexed keeper, bool allowed);
    event ExcessEthSwept(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    // ---------------------------------------------------------------- errors

    error NotKeeper();
    error NotPlanOwner();
    error BadParams();
    error PlanIsCancelled();
    error NotExecutable(Skip reason);
    error LengthMismatch();
    error EthTransferFailed();
    error ZeroAddress();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Proxy initializer.
    function initialize(
        address owner_,
        address router_,
        address quoter_,
        address wif_,
        address hooks_,
        uint24 poolFee_,
        int24 tickSpacing_
    ) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        if (router_ == address(0) || quoter_ == address(0) || wif_ == address(0)) revert ZeroAddress();
        router = IUniversalRouter(router_);
        quoter = IV4Quoter(quoter_);
        wif = IERC20(wif_);
        hooks = hooks_;
        poolFee = poolFee_;
        tickSpacing = tickSpacing_;
        nextPlanId = 1;
    }

    /// @dev UUPS: only the owner can upgrade.
    function _authorizeUpgrade(address) internal override onlyOwner {}


    modifier onlyKeeper() {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        _;
    }

    modifier onlyPlanOwner(uint256 planId) {
        if (_plans[planId].owner != msg.sender) revert NotPlanOwner();
        _;
    }

    // ================================================================ user

    /// @notice Create a plan funded with msg.value. `startAt` 0 = first buy allowed right away.
    function createPlan(PlanParams calldata p, uint40 startAt)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 planId)
    {
        _check(p);
        if (msg.value > type(uint128).max) revert BadParams();
        if (startAt < block.timestamp) startAt = uint40(block.timestamp);
        planId = nextPlanId++;
        Plan storage pl = _plans[planId];
        pl.owner = msg.sender;
        pl.startAt = startAt;
        pl.balance = uint128(msg.value);
        _apply(pl, p);
        _plansOf[msg.sender].push(planId);
        totalDeposits += msg.value;
        emit PlanCreated(
            planId,
            msg.sender,
            msg.value,
            p.amountPerBuy,
            p.interval,
            p.maxBuys,
            p.minWifPerEth,
            p.maxSlippageBps,
            p.keeperTip,
            startAt
        );
    }

    /// @notice Add ETH to your plan (works while the contract is paused).
    function topUp(uint256 planId) external payable nonReentrant onlyPlanOwner(planId) {
        Plan storage pl = _plans[planId];
        if (pl.cancelled) revert PlanIsCancelled();
        if (msg.value == 0) revert BadParams();
        uint256 nb = uint256(pl.balance) + msg.value;
        if (nb > type(uint128).max) revert BadParams();
        pl.balance = uint128(nb);
        totalDeposits += msg.value;
        emit ToppedUp(planId, msg.value, nb);
    }

    /// @notice Change amount, interval, number of buys, price floor, slippage and tip. Interval counts from the last buy.
    function updatePlan(uint256 planId, PlanParams calldata p) external nonReentrant onlyPlanOwner(planId) {
        Plan storage pl = _plans[planId];
        if (pl.cancelled) revert PlanIsCancelled();
        _check(p);
        _apply(pl, p);
        emit PlanUpdated(planId, p.amountPerBuy, p.interval, p.maxBuys, p.minWifPerEth, p.maxSlippageBps, p.keeperTip);
    }

    function setPlanPaused(uint256 planId, bool paused_) external nonReentrant onlyPlanOwner(planId) {
        Plan storage pl = _plans[planId];
        if (pl.cancelled) revert PlanIsCancelled();
        pl.paused = paused_;
        emit PlanPaused(planId, paused_);
    }

    /// @notice Withdraw `amount` ETH from your plan to your wallet. Always works, even while paused.
    function withdraw(uint256 planId, uint256 amount) external nonReentrant onlyPlanOwner(planId) {
        _withdraw(planId, amount);
    }

    /// @notice Withdraw everything still in your plan. Always works, even while paused.
    function withdrawAll(uint256 planId) external nonReentrant onlyPlanOwner(planId) {
        _withdraw(planId, _plans[planId].balance);
    }

    /// @notice Stop the plan for good and refund what is left. Always works, even while paused.
    function cancelPlan(uint256 planId) external nonReentrant onlyPlanOwner(planId) {
        Plan storage pl = _plans[planId];
        if (pl.cancelled) revert PlanIsCancelled();
        pl.cancelled = true;
        uint256 refund = pl.balance;
        if (refund > 0) _withdraw(planId, refund);
        emit PlanCancelled(planId, refund);
    }

    // ================================================================ keeper

    /// @notice Buy for one plan. Reverts with NotExecutable(reason) / the router's error when it can't.
    /// @param minWifOut Minimum WIF the owner must receive.
    function execute(uint256 planId, uint256 minWifOut)
        external
        nonReentrant
        whenNotPaused
        onlyKeeper
        returns (uint256 wifOut)
    {
        Skip r;
        (r, wifOut) = _execute(planId, minWifOut);
        if (r != Skip.None) revert NotExecutable(r);
    }

    /// @notice Buy for many plans; plans that can't be bought are skipped instead of reverting.
    function executeBatch(uint256[] calldata planIds, uint256[] calldata minWifOuts)
        external
        nonReentrant
        whenNotPaused
        onlyKeeper
        returns (uint256 executed)
    {
        if (planIds.length != minWifOuts.length) revert LengthMismatch();
        for (uint256 i; i < planIds.length; ++i) {
            (Skip r,) = _execute(planIds[i], minWifOuts[i]);
            if (r == Skip.None) ++executed;
            else emit Skipped(planIds[i], r);
        }
    }

    // ================================================================ admin

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    /// @notice Pauses execute and createPlan only. Top-ups, edits, withdrawals and cancels keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Sends ETH that is not part of any plan (only possible via selfdestruct / coinbase) to `to`.
    function sweepExcessEth(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 excess = address(this).balance - totalDeposits;
        _sendEth(to, excess);
        emit ExcessEthSwept(to, excess);
    }

    /// @notice Recovers tokens sent here by mistake. The contract never holds WIF or any token for users.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    // ================================================================ views

    function getPlan(uint256 planId) external view returns (Plan memory) {
        return _plans[planId];
    }

    function plansOf(address owner_) external view returns (uint256[] memory) {
        return _plansOf[owner_];
    }

    function poolKey() public view returns (PoolKey memory) {
        return
            PoolKey({
                currency0: address(0), currency1: address(wif), fee: poolFee, tickSpacing: tickSpacing, hooks: hooks
            });
    }

    /// @notice Earliest time of the next buy (ignores balance/pause; see status()).
    function nextBuyAt(uint256 planId) public view returns (uint256) {
        Plan storage pl = _plans[planId];
        uint256 t = pl.lastBuyAt == 0 ? 0 : uint256(pl.lastBuyAt) + pl.interval;
        return t > pl.startAt ? t : pl.startAt;
    }

    /// @notice Skip.None if the plan can be bought now (before price checks), else the reason.
    function status(uint256 planId) public view returns (Skip) {
        Plan storage pl = _plans[planId];
        if (pl.owner == address(0)) return Skip.NoPlan;
        if (pl.cancelled) return Skip.Cancelled;
        if (pl.paused) return Skip.PlanPaused;
        if (pl.maxBuys != 0 && pl.buysDone >= pl.maxBuys) return Skip.Finished;
        if (block.timestamp < nextBuyAt(planId)) return Skip.NotDue;
        if (pl.balance < uint256(pl.amountPerBuy) + pl.keeperTip) return Skip.LowBalance;
        return Skip.None;
    }

    /// @notice The lowest minWifOut the user's price floor allows (0 = no floor).
    function floorWifOut(uint256 planId) public view returns (uint256) {
        Plan storage pl = _plans[planId];
        return Math.mulDiv(pl.amountPerBuy, pl.minWifPerEth, 1e18, Math.Rounding.Ceil);
    }

    /// @notice How many buys the plan can still make with its balance and maxBuys.
    function buysLeft(uint256 planId) external view returns (uint256 n) {
        Plan storage pl = _plans[planId];
        if (pl.cancelled || pl.owner == address(0)) return 0;
        n = pl.balance / (uint256(pl.amountPerBuy) + pl.keeperTip);
        if (pl.maxBuys != 0) {
            uint256 cap = pl.buysDone >= pl.maxBuys ? 0 : pl.maxBuys - pl.buysDone;
            if (cap < n) n = cap;
        }
    }

    // ================================================================ internal

    function _check(PlanParams calldata p) internal pure {
        if (p.amountPerBuy == 0 || p.interval < MIN_INTERVAL) revert BadParams();
        if (p.maxSlippageBps > MAX_SLIPPAGE_BPS) revert BadParams();
        if (p.minWifPerEth == 0 && p.maxSlippageBps == 0) revert BadParams(); // need a floor or a slippage cap
        if (p.keeperTip > p.amountPerBuy) revert BadParams(); // tip is meant to be small
    }

    function _apply(Plan storage pl, PlanParams calldata p) internal {
        pl.amountPerBuy = p.amountPerBuy;
        pl.interval = p.interval;
        pl.maxBuys = p.maxBuys;
        pl.minWifPerEth = p.minWifPerEth;
        pl.maxSlippageBps = p.maxSlippageBps;
        pl.keeperTip = p.keeperTip;
    }

    function _withdraw(uint256 planId, uint256 amount) internal {
        Plan storage pl = _plans[planId];
        if (amount == 0 || amount > pl.balance) revert BadParams();
        uint256 nb = pl.balance - amount;
        pl.balance = uint128(nb);
        totalDeposits -= amount;
        _sendEth(msg.sender, amount);
        emit Withdrawn(planId, msg.sender, amount, nb);
    }

    function _execute(uint256 planId, uint256 minWifOut) internal returns (Skip r, uint256 wifOut) {
        r = status(planId);
        if (r == Skip.None) r = _priceCheck(planId, minWifOut);
        if (r == Skip.None) (r, wifOut) = _buy(planId, minWifOut);
    }

    /// @dev Checks the user's price floor, then the slippage cap against an on-chain quote.
    function _priceCheck(uint256 planId, uint256 minWifOut) internal returns (Skip) {
        Plan storage pl = _plans[planId];
        if (minWifOut == 0 || minWifOut > type(uint128).max || minWifOut < floorWifOut(planId)) return Skip.BelowFloor;
        uint256 slip = pl.maxSlippageBps;
        if (slip == 0) return Skip.None;
        try quoter.quoteExactInputSingle(
            QuoteExactSingleParams({poolKey: poolKey(), zeroForOne: true, exactAmount: pl.amountPerBuy, hookData: ""})
        ) returns (
            uint256 quoted, uint256
        ) {
            if (minWifOut < quoted * (BPS - slip) / BPS) return Skip.TooMuchSlippage;
            return Skip.None;
        } catch {
            return Skip.QuoteFailed;
        }
    }

    /// @dev Effects first, then the swap. A failed swap is rolled back by hand so a batch can skip it.
    function _buy(uint256 planId, uint256 minWifOut) internal returns (Skip r, uint256 wifOut) {
        Plan storage pl = _plans[planId];
        address planOwner = pl.owner;
        uint128 amountIn = pl.amountPerBuy;
        uint256 cost = uint256(amountIn) + pl.keeperTip;
        uint40 prevLastBuy = pl.lastBuyAt;
        pl.balance -= uint128(cost);
        totalDeposits -= cost;
        pl.lastBuyAt = uint40(block.timestamp);
        pl.buysDone += 1;

        uint256 before = wif.balanceOf(planOwner);
        (bytes memory commands, bytes[] memory inputs) = _swapCall(amountIn, uint128(minWifOut), planOwner);
        try router.execute{value: amountIn}(commands, inputs, block.timestamp) {
            wifOut = wif.balanceOf(planOwner) - before;
            // revert so the whole buy rolls back
            if (wifOut < minWifOut) revert NotExecutable(Skip.ShortOutput);
        } catch {
            pl.balance += uint128(cost);
            totalDeposits += cost;
            pl.buysDone -= 1;
            pl.lastBuyAt = prevLastBuy;
            return (Skip.SwapFailed, 0);
        }

        _settle(planId, wifOut);
    }

    /// @dev Stats, keeper tip, event.
    function _settle(uint256 planId, uint256 wifOut) internal {
        Plan storage pl = _plans[planId];
        pl.totalEthSpent += pl.amountPerBuy;
        pl.totalWifBought += uint128(wifOut);
        uint256 tip = pl.keeperTip;
        if (tip != 0) _sendEth(msg.sender, tip);
        emit Bought(planId, pl.owner, msg.sender, pl.amountPerBuy, wifOut, tip, pl.buysDone, pl.balance);
    }

    /// @dev V4_SWAP: swap ETH -> WIF, settle ETH, take all WIF to the plan owner.
    function _swapCall(uint128 amountIn, uint128 minOut, address recipient)
        internal
        view
        returns (bytes memory commands, bytes[] memory inputs)
    {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: poolKey(), zeroForOne: true, amountIn: amountIn, amountOutMinimum: minOut, hookData: ""
            })
        );
        params[1] = abi.encode(address(0), uint256(amountIn));
        params[2] = abi.encode(address(wif), recipient, uint256(0)); // 0 = OPEN_DELTA: take the full output
        commands = abi.encodePacked(V4_SWAP);
        inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE), params);
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
