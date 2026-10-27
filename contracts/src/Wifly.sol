// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IBurnableERC20} from "./interfaces/IBurnableERC20.sol";

/// @title Wifly
/// @notice Social payments on $WIF: tips, subscriptions, unlocks, payments, Top Spot, weekly votes and agents.
contract Wifly is
    Initializable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 500; // 5%
    /// @notice Fee split: 90% to the community pot, 10% burned.
    uint256 public constant POT_BPS = 9_000;
    uint256 public constant BURN_BPS = 1_000;
    uint256 public constant TOP_SPOT_PREV_BPS = 9_000; // 90% to the previous holder, 10% through _splitFee
    uint256 public constant TOP_SPOT_STEP_BPS = 11_000; // next bid >= 110% of current
    uint256 public constant MAX_TOP_SPOT_HOLD = 1 days;
    uint256 public constant SUB_PERIOD = 30 days; // monthly plan
    uint256 public constant YEAR_PERIOD = 365 days; // yearly plan
    uint8 public constant MONTHLY = 0;
    uint8 public constant YEARLY = 1;
    uint256 public constant MAX_TIERS = 3;
    uint256 public constant REFUND_DELAY = 30 days;
    uint256 public constant EPOCH_LENGTH = 7 days;
    uint256 public constant MIN_GRACE = 1 days;
    uint256 public constant MAX_GRACE = 30 days;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    bytes32 public constant LINK_TYPEHASH =
        keccak256("LinkHandle(bytes32 handleHash,address account,uint256 nonce,uint256 deadline)");

    // ------------------------------------------------------------------ token (set once in initialize)
    IERC20 public wif;
    /// @notice true: call wif.burn(); false: transfer to 0x…dEaD.
    bool public useBurnFunction;

    // ------------------------------------------------------------------ config
    uint256 public feeBps; // 2% (set in initialize)
    address public treasury;
    address public attester;
    uint256 public topSpotFloor;
    uint256 public topSpotMinHold; // 60 s (set in initialize)
    /// @notice Access window after a subscription expires.
    uint256 public gracePeriod; // 5 days (set in initialize)

    // ------------------------------------------------------------------ accounting
    mapping(address => uint256) public balances; // withdrawable (earnings + deposits)
    uint256 public totalBalances;
    uint256 public totalEscrow; // sum of handleEscrow
    /// @dev Community pot; only finalizeEpoch can spend it.
    uint256 public epochPot;
    uint256 public totalVoterPools; // reserved for unclaimed voter rewards
    uint256 public totalBurned;

    // ------------------------------------------------------------------ X handle escrow
    struct HandleTip {
        address tipper;
        uint64 createdAt;
        bool settled; // refunded
        bytes32 handleHash;
        uint256 amount; // net of fee
    }

    mapping(bytes32 => address) public handleOwner;
    mapping(bytes32 => uint256) public handleNonce;
    mapping(bytes32 => uint256) public handleEscrow;
    mapping(uint256 => HandleTip) public handleTips;
    uint256 public nextHandleTipId; // starts at 1 (set in initialize)

    // ------------------------------------------------------------------ subscriptions
    struct Sub {
        uint64 expiry;
        uint8 tier;
        uint8 plan; // MONTHLY or YEARLY, last paid
    }

    mapping(address => uint256[MAX_TIERS]) internal _tierPrice; // monthly price, 0 = monthly plan disabled
    mapping(address => uint256[MAX_TIERS]) internal _yearlyPrice; // yearly price, 0 = yearly plan disabled
    mapping(address => mapping(address => Sub)) internal _subs; // user => creator => Sub

    /// @dev Opt-in auto-renew. maxPrice 0 = off. The plan price at renewal must be <= maxPrice.
    struct AutoRenew {
        uint8 tier;
        uint8 plan;
        uint240 maxPrice;
    }

    mapping(address => mapping(address => AutoRenew)) public autoRenewOf; // user => creator

    // ------------------------------------------------------------------ unlocks
    mapping(address => mapping(bytes32 => uint256)) public contentPrice; // creator => contentId => price
    mapping(address => mapping(address => mapping(bytes32 => bool))) internal _unlocked; // user => creator => id

    // ------------------------------------------------------------------ top spot
    struct TopSpot {
        address holder;
        uint64 takenAt;
        bytes32 postId;
        uint256 amount;
    }

    TopSpot public topSpot;

    // ------------------------------------------------------------------ pay-to-vote
    struct Epoch {
        address leader; // creator with the most votes (first to reach the top wins ties)
        bool finalized;
        uint256 leaderVotes;
        uint256 voterPool;
        uint256 voterPoolLeft;
    }

    uint256 public winnerShareBps; // 50% (set in initialize): share of the pot to the crowd-pick creator
    uint256 public voterShareBps; // 50% (set in initialize): share of the pot to that creator's voters
    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(address => uint256)) public creatorVotes; // epoch => creator => votes
    mapping(uint256 => mapping(address => mapping(address => uint256))) public voterVotes; // epoch => voter => creator
    mapping(uint256 => mapping(address => bool)) public voterRewardClaimed; // epoch => voter

    // ------------------------------------------------------------------ agents
    struct Agent {
        address agent;
        uint128 dailyCap;
        uint128 spentToday;
        uint64 day;
    }

    mapping(address => Agent) public agents;

    /// @dev Pot inflow during week `potInEpoch`.
    uint256 public potInCurrent;
    uint256 public potInEpoch;

    /// @dev Reserved storage for future upgrades.
    uint256[48] private __gap;

    // ------------------------------------------------------------------ events
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Tipped(address indexed from, address indexed creator, bytes32 indexed postId, uint256 amount, uint256 fee);
    event HandleTipped(
        uint256 indexed tipId,
        address indexed from,
        bytes32 indexed handleHash,
        bytes32 postId,
        uint256 amount,
        uint256 fee
    );
    event HandleLinked(bytes32 indexed handleHash, address indexed account, uint256 escrowReleased);
    event HandleTipRefunded(uint256 indexed tipId, address indexed tipper, uint256 amount);
    event TierSet(address indexed creator, uint8 indexed tier, uint256 price); // monthly price
    event YearlyPriceSet(address indexed creator, uint8 indexed tier, uint256 price);
    event Subscribed(
        address indexed user,
        address indexed creator,
        uint8 tier,
        uint64 expiry,
        uint256 amount,
        uint256 fee,
        address payer,
        uint8 plan
    );
    event ContentPriceSet(address indexed creator, bytes32 indexed contentId, uint256 price);
    event Unlocked(
        address indexed user, address indexed creator, bytes32 indexed contentId, uint256 amount, uint256 fee
    );
    event Paid(address indexed buyer, address indexed seller, bytes32 indexed orderId, uint256 amount, uint256 fee);
    event TopSpotTaken(
        address indexed holder,
        bytes32 indexed postId,
        uint256 amount,
        address indexed previousHolder,
        uint256 previousPayout
    );
    event AutoRenewSet(address indexed user, address indexed creator, uint8 tier, uint8 plan, uint256 maxPrice);
    event TreasurySet(address indexed treasury);
    event GracePeriodSet(uint256 gracePeriod);
    event AgentSet(address indexed user, address indexed agent, uint256 dailyCap);
    event AgentSpent(address indexed user, address indexed agent, uint256 amount, uint256 spentToday);
    event Burned(uint256 amount);
    /// @notice One split of `potAmount + burnAmount` WIF (fee, vote, Top Spot slice).
    event FeeSplit(uint256 potAmount, uint256 burnAmount);
    /// @notice WIF added to the community pot via `fundPot`.
    event PotFunded(address indexed from, uint256 amount);
    event FeeSet(uint256 feeBps);
    event AttesterSet(address indexed attester);
    event TopSpotParamsSet(uint256 floor, uint256 minHold);
    event Voted(address indexed voter, address indexed creator, bytes32 indexed postId, uint256 amount, uint256 epoch);
    event EpochFinalized(uint256 indexed epoch, address indexed winner, uint256 creatorReward, uint256 voterPool);
    event VoterRewardClaimed(uint256 indexed epoch, address indexed voter, uint256 amount);
    event EpochSharesSet(uint256 winnerShareBps, uint256 voterShareBps);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    // ------------------------------------------------------------------ errors
    error ZeroAmount();
    error ZeroAddress();
    error FeeTooHigh();
    error InsufficientBalance();
    error NotAuthorized();
    error AgentCapExceeded();
    error InvalidTier();
    error InvalidPlan();
    error TierDisabled();
    error NotForSale();
    error AlreadyUnlocked();
    error BidTooLow(uint256 minimum);
    error TopSpotLocked(uint256 until);
    error HoldTooLong();
    error SelfPayment();
    error Expired();
    error BadSignature();
    error HandleAlreadyLinked();
    error NotTipper();
    error RefundNotAvailable();
    error ExceedsExcess();
    error EpochNotOver();
    error AlreadyFinalized();
    error NotFinalized();
    error NotLeader(address leader);
    error NoVotes();
    error AlreadyClaimed();
    error SharesTooHigh();
    error AutoRenewOff();
    error PriceAboveMax(uint256 price, uint256 maxPrice);
    error NotRenewable();
    error BadGrace();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Proxy initializer.
    function initialize(
        address wif_,
        bool useBurnFunction_,
        address owner_,
        address attester_,
        address treasury_,
        uint256 topSpotFloor_
    ) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __EIP712_init("Wifly", "1");
        __UUPSUpgradeable_init();
        if (wif_ == address(0) || attester_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (topSpotFloor_ == 0) revert ZeroAmount();
        wif = IERC20(wif_);
        useBurnFunction = useBurnFunction_;
        attester = attester_;
        treasury = treasury_;
        topSpotFloor = topSpotFloor_;
        feeBps = 200;
        topSpotMinHold = 60;
        gracePeriod = 5 days;
        nextHandleTipId = 1;
        winnerShareBps = 5_000;
        voterShareBps = 5_000;
        emit AttesterSet(attester_);
        emit TreasurySet(treasury_);
        emit TopSpotParamsSet(topSpotFloor_, topSpotMinHold);
    }

    /// @dev UUPS: only the owner can upgrade.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // =================================================================== balance
    /// @notice Deposit WIF for one-tap spending and agent spending.
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        _credit(msg.sender, amount);
        emit Deposited(msg.sender, amount);
        wif.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Withdraw the whole balance. Works while paused. Agents can never call this for a user.
    function withdraw() external nonReentrant {
        _withdraw(balances[msg.sender]);
    }

    function withdrawAmount(uint256 amount) external nonReentrant {
        _withdraw(amount);
    }

    // =================================================================== tips
    function tip(address creator, uint256 amount, bytes32 postId) external nonReentrant whenNotPaused {
        _pull(msg.sender, amount);
        _tip(msg.sender, creator, amount, postId);
    }

    /// @notice Tip from `user`'s deposited balance. Callable by the user or their agent (cap applies).
    function tipFor(address user, address creator, uint256 amount, bytes32 postId) external nonReentrant whenNotPaused {
        _spendBalance(user, amount);
        _tip(user, creator, amount, postId);
    }

    /// @notice Tip an X account; escrowed until the handle is linked.
    function tipHandle(bytes32 handleHash, uint256 amount, bytes32 postId)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 tipId)
    {
        if (handleHash == bytes32(0)) revert ZeroAddress();
        _pull(msg.sender, amount);
        address linked = handleOwner[handleHash];
        if (linked != address(0)) {
            _tip(msg.sender, linked, amount, postId);
            return 0;
        }
        uint256 net = amount - _takeFee(amount);
        tipId = nextHandleTipId++;
        handleTips[tipId] = HandleTip({
            tipper: msg.sender, createdAt: uint64(block.timestamp), settled: false, handleHash: handleHash, amount: net
        });
        handleEscrow[handleHash] += net;
        totalEscrow += net;
        emit HandleTipped(tipId, msg.sender, handleHash, postId, amount, amount - net);
    }

    /// @notice Link an X account to msg.sender with an attester EIP-712 signature and release its escrow.
    function linkHandle(bytes32 handleHash, uint256 deadline, bytes calldata signature) external nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        if (handleOwner[handleHash] == msg.sender) revert HandleAlreadyLinked();
        uint256 nonce = handleNonce[handleHash];
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(LINK_TYPEHASH, handleHash, msg.sender, nonce, deadline)));
        if (ECDSA.recover(digest, signature) != attester) revert BadSignature();

        handleNonce[handleHash] = nonce + 1;
        handleOwner[handleHash] = msg.sender;
        uint256 released = handleEscrow[handleHash];
        if (released != 0) {
            handleEscrow[handleHash] = 0;
            totalEscrow -= released;
        }
        emit HandleLinked(handleHash, msg.sender, released);
        if (released != 0) wif.safeTransfer(msg.sender, released);
    }

    /// @notice Reclaim an escrowed tip (net of fee) if the handle stays unlinked for REFUND_DELAY.
    function refundHandleTip(uint256 tipId) external nonReentrant {
        HandleTip storage t = handleTips[tipId];
        if (t.tipper != msg.sender) revert NotTipper();
        if (t.settled || handleOwner[t.handleHash] != address(0) || block.timestamp < t.createdAt + REFUND_DELAY) {
            revert RefundNotAvailable();
        }
        t.settled = true;
        uint256 amount = t.amount;
        handleEscrow[t.handleHash] -= amount;
        totalEscrow -= amount;
        _credit(msg.sender, amount);
        emit HandleTipRefunded(tipId, msg.sender, amount);
    }

    // =================================================================== subscriptions
    /// @notice Creator sets a monthly price for tier 0..2. Price 0 disables the tier.
    function setTier(uint8 tier, uint256 price) external {
        if (tier >= MAX_TIERS) revert InvalidTier();
        _tierPrice[msg.sender][tier] = price;
        emit TierSet(msg.sender, tier, price);
    }

    /// @notice Creator sets a yearly price for a tier. Price 0 disables the yearly plan.
    function setYearlyPrice(uint8 tier, uint256 price) external {
        if (tier >= MAX_TIERS) revert InvalidTier();
        _yearlyPrice[msg.sender][tier] = price;
        emit YearlyPriceSet(msg.sender, tier, price);
    }

    /// @notice Monthly subscription paid from the wallet.
    function subscribe(address creator, uint8 tier) external {
        subscribePlan(creator, tier, MONTHLY);
    }

    /// @notice Subscribe for 30 days (plan 0) or 365 days (plan 1), paid from the wallet.
    function subscribePlan(address creator, uint8 tier, uint8 plan) public nonReentrant whenNotPaused {
        uint256 price = _priceOf(creator, tier, plan);
        _pull(msg.sender, price);
        _subscribe(msg.sender, creator, tier, plan, price);
    }

    /// @notice Monthly subscribe/renew from `user`'s deposited balance. Callable by the user or their agent.
    function subscribeFor(address user, address creator, uint8 tier) external {
        subscribeForPlan(user, creator, tier, MONTHLY);
    }

    /// @notice Subscribe from `user`'s deposited balance for a chosen plan. Callable by the user or their agent.
    function subscribeForPlan(address user, address creator, uint8 tier, uint8 plan) public nonReentrant whenNotPaused {
        uint256 price = _priceOf(creator, tier, plan);
        _spendBalance(user, price);
        _subscribe(user, creator, tier, plan, price);
    }

    /// @notice Opt in to auto-renew with a max price per renewal; maxPrice 0 opts out.
    function setAutoRenew(address creator, uint8 tier, uint8 plan, uint256 maxPrice) external {
        if (tier >= MAX_TIERS) revert InvalidTier();
        if (plan > YEARLY) revert InvalidPlan();
        if (creator == address(0)) revert ZeroAddress();
        if (creator == msg.sender) revert SelfPayment();
        if (maxPrice > type(uint240).max) maxPrice = type(uint240).max;
        if (maxPrice == 0) {
            delete autoRenewOf[msg.sender][creator];
            emit AutoRenewSet(msg.sender, creator, 0, 0, 0);
        } else {
            autoRenewOf[msg.sender][creator] = AutoRenew({tier: tier, plan: plan, maxPrice: uint240(maxPrice)});
            emit AutoRenewSet(msg.sender, creator, tier, plan, maxPrice);
        }
    }

    /// @notice Anyone can renew an expired opted-in subscription; pays from balance, else from the wallet.
    function renew(address user, address creator) external nonReentrant whenNotPaused {
        AutoRenew memory a = autoRenewOf[user][creator];
        if (a.maxPrice == 0) revert AutoRenewOff();
        uint64 expiry = _subs[user][creator].expiry;
        if (expiry == 0 || block.timestamp < expiry) revert NotRenewable();
        uint256 price = _priceOf(creator, a.tier, a.plan);
        if (price > a.maxPrice) revert PriceAboveMax(price, a.maxPrice);
        if (balances[user] >= price) _debit(user, price);
        else _pull(user, price);
        _subscribe(user, creator, a.tier, a.plan, price);
    }

    // =================================================================== unlocks & pay
    /// @notice Creator sets the price of their content. Ids are namespaced per creator. 0 = not for sale.
    function setContentPrice(bytes32 contentId, uint256 price) external {
        contentPrice[msg.sender][contentId] = price;
        emit ContentPriceSet(msg.sender, contentId, price);
    }

    function unlock(address creator, bytes32 contentId) external nonReentrant whenNotPaused {
        uint256 price = contentPrice[creator][contentId];
        if (price == 0) revert NotForSale();
        if (_unlocked[msg.sender][creator][contentId]) revert AlreadyUnlocked();
        if (creator == msg.sender) revert SelfPayment();
        _unlocked[msg.sender][creator][contentId] = true;
        _pull(msg.sender, price);
        uint256 fee = _takeFee(price);
        _credit(creator, price - fee);
        emit Unlocked(msg.sender, creator, contentId, price, fee);
    }

    /// @notice Generic payment for shop items, paid DMs and pay links.
    function pay(address seller, uint256 amount, bytes32 orderId) external nonReentrant whenNotPaused {
        if (seller == address(0)) revert ZeroAddress();
        if (seller == msg.sender) revert SelfPayment();
        _pull(msg.sender, amount);
        uint256 fee = _takeFee(amount);
        _credit(seller, amount - fee);
        emit Paid(msg.sender, seller, orderId, amount, fee);
    }

    // =================================================================== top spot
    function takeTopSpot(bytes32 postId, uint256 amount) external nonReentrant whenNotPaused {
        _checkTopSpotBid(amount);
        _pull(msg.sender, amount);
        _takeTopSpot(msg.sender, postId, amount);
    }

    function takeTopSpotFor(address user, bytes32 postId, uint256 amount) external nonReentrant whenNotPaused {
        _checkTopSpotBid(amount);
        _spendBalance(user, amount);
        _takeTopSpot(user, postId, amount);
    }

    // =================================================================== community pot
    /// @notice Add WIF to the community pot. Works while paused.
    function fundPot(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _addToPot(amount);
        emit PotFunded(msg.sender, amount);
        wif.safeTransferFrom(msg.sender, address(this), amount);
    }

    // =================================================================== vote
    /// @notice Vote for a creator's post this week; the vote is split 90% to the pot, 10% burned.
    function vote(bytes32 postId, address creator, uint256 amount) external nonReentrant whenNotPaused {
        if (creator == address(0)) revert ZeroAddress();
        if (creator == msg.sender) revert SelfPayment();
        _pull(msg.sender, amount);
        uint256 epoch = currentEpoch();
        uint256 total = creatorVotes[epoch][creator] + amount;
        creatorVotes[epoch][creator] = total;
        voterVotes[epoch][msg.sender][creator] += amount;
        Epoch storage e = epochs[epoch];
        if (total > e.leaderVotes) {
            e.leader = creator;
            e.leaderVotes = total;
        }
        emit Voted(msg.sender, creator, postId, amount, epoch);
        _splitFee(amount);
    }

    /// @notice Close a past week and split `payablePot()` between the winner and its voters.
    function finalizeEpoch(uint256 epoch, address winner) external nonReentrant {
        if (epoch >= currentEpoch()) revert EpochNotOver();
        Epoch storage e = epochs[epoch];
        if (e.finalized) revert AlreadyFinalized();
        if (e.leader == address(0)) revert NoVotes();
        if (winner != e.leader) revert NotLeader(e.leader);
        uint256 pot = payablePot();
        uint256 creatorReward = (pot * winnerShareBps) / BPS;
        uint256 voterPool = (pot * voterShareBps) / BPS;
        e.finalized = true;
        e.voterPool = voterPool;
        e.voterPoolLeft = voterPool;
        epochPot -= creatorReward + voterPool;
        totalVoterPools += voterPool;
        _credit(winner, creatorReward);
        emit EpochFinalized(epoch, winner, creatorReward, voterPool);
    }

    /// @notice Voters for the epoch's winner claim pro-rata from the voter pool (credited to balance).
    function claimVoterReward(uint256 epoch) external nonReentrant returns (uint256 amount) {
        Epoch storage e = epochs[epoch];
        if (!e.finalized) revert NotFinalized();
        if (voterRewardClaimed[epoch][msg.sender]) revert AlreadyClaimed();
        uint256 votes = voterVotes[epoch][msg.sender][e.leader];
        if (votes == 0) revert NoVotes();
        voterRewardClaimed[epoch][msg.sender] = true;
        amount = (e.voterPool * votes) / e.leaderVotes; // rounds down; dust stays reserved
        e.voterPoolLeft -= amount;
        totalVoterPools -= amount;
        _credit(msg.sender, amount);
        emit VoterRewardClaimed(epoch, msg.sender, amount);
    }

    // =================================================================== agents
    /// @notice Authorize one agent with a daily WIF cap. agent = address(0) revokes.
    function setAgent(address agent, uint128 dailyCap) external {
        Agent storage a = agents[msg.sender];
        a.agent = agent;
        a.dailyCap = agent == address(0) ? 0 : dailyCap;
        emit AgentSet(msg.sender, agent, a.dailyCap);
    }

    function revokeAgent() external {
        delete agents[msg.sender];
        emit AgentSet(msg.sender, address(0), 0);
    }

    // =================================================================== owner
    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = newFeeBps;
        emit FeeSet(newFeeBps);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasurySet(newTreasury);
    }

    function setAttester(address newAttester) external onlyOwner {
        if (newAttester == address(0)) revert ZeroAddress();
        attester = newAttester;
        emit AttesterSet(newAttester);
    }

    function setTopSpotParams(uint256 floor, uint256 minHold) external onlyOwner {
        if (floor == 0) revert ZeroAmount();
        if (minHold > MAX_TOP_SPOT_HOLD) revert HoldTooLong();
        topSpotFloor = floor;
        topSpotMinHold = minHold;
        emit TopSpotParamsSet(floor, minHold);
    }

    function setGracePeriod(uint256 newGrace) external onlyOwner {
        if (newGrace < MIN_GRACE || newGrace > MAX_GRACE) revert BadGrace();
        gracePeriod = newGrace;
        emit GracePeriodSet(newGrace);
    }

    function setEpochShares(uint256 winnerBps, uint256 voterBps) external onlyOwner {
        if (winnerBps + voterBps > BPS) revert SharesTooHigh();
        winnerShareBps = winnerBps;
        voterShareBps = voterBps;
        emit EpochSharesSet(winnerBps, voterBps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover tokens sent here by mistake. For WIF only the excess over liabilities.
    function rescue(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(wif) && amount > excessWif()) revert ExceedsExcess();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    // =================================================================== views
    function isSubscribed(address user, address creator)
        external
        view
        returns (bool active, uint8 tier, uint64 expiry)
    {
        Sub memory s = _subs[user][creator];
        return (s.expiry > block.timestamp, s.tier, s.expiry);
    }

    /// @notice Full status: `active` = paid period running; `hasAccess` = active or still in grace.
    function subStatus(address user, address creator)
        external
        view
        returns (bool active, bool hasAccess, uint8 tier, uint64 expiry, uint256 graceEndsAt, uint8 plan)
    {
        Sub memory s = _subs[user][creator];
        graceEndsAt = s.expiry == 0 ? 0 : s.expiry + gracePeriod;
        return (s.expiry > block.timestamp, graceEndsAt > block.timestamp, s.tier, s.expiry, graceEndsAt, s.plan);
    }

    /// @notice Monthly prices per tier (0 = monthly plan disabled).
    function tierPrices(address creator) external view returns (uint256[MAX_TIERS] memory) {
        return _tierPrice[creator];
    }

    /// @notice Yearly prices per tier (0 = yearly plan disabled).
    function yearlyPrices(address creator) external view returns (uint256[MAX_TIERS] memory) {
        return _yearlyPrice[creator];
    }

    function hasUnlocked(address user, address creator, bytes32 contentId) external view returns (bool) {
        return _unlocked[user][creator][contentId];
    }

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH_LENGTH;
    }

    function epochEndsAt(uint256 epoch) external pure returns (uint256) {
        return (epoch + 1) * EPOCH_LENGTH;
    }

    /// @notice Reward `voter` could claim for a finalized epoch (0 if none or already claimed).
    function pendingVoterReward(uint256 epoch, address voter) external view returns (uint256) {
        Epoch memory e = epochs[epoch];
        if (!e.finalized || voterRewardClaimed[epoch][voter]) return 0;
        return (e.voterPool * voterVotes[epoch][voter][e.leader]) / e.leaderVotes;
    }

    function minTopSpotBid() public view returns (uint256) {
        uint256 current = topSpot.amount;
        if (topSpot.holder == address(0)) return topSpotFloor;
        uint256 stepped = (current * TOP_SPOT_STEP_BPS + BPS - 1) / BPS; // round up
        return stepped > topSpotFloor ? stepped : topSpotFloor;
    }

    function topSpotUnlocksAt() public view returns (uint256) {
        return topSpot.holder == address(0) ? 0 : uint256(topSpot.takenAt) + topSpotMinHold;
    }

    /// @notice Remaining agent allowance for today.
    function agentRemaining(address user) external view returns (uint256) {
        Agent memory a = agents[user];
        if (a.agent == address(0)) return 0;
        uint256 spent = a.day == _today() ? a.spentToday : 0;
        return spent >= a.dailyCap ? 0 : a.dailyCap - spent;
    }

    function totalLiabilities() public view returns (uint256) {
        return totalBalances + totalEscrow + epochPot + totalVoterPools;
    }

    function excessWif() public view returns (uint256) {
        uint256 bal = wif.balanceOf(address(this));
        uint256 liab = totalLiabilities();
        return bal > liab ? bal - liab : 0;
    }

    /// @notice Fee preview: (fee, pot part, burned part, net to recipient).
    function quoteFee(uint256 amount) external view returns (uint256 fee, uint256 potPart, uint256 burnPart, uint256 net) {
        fee = (amount * feeBps) / BPS;
        (potPart, burnPart) = quoteSplit(fee);
        net = amount - fee;
    }

    /// @notice Split of `amount`: 10% burned (rounded down), the rest to the pot.
    function quoteSplit(uint256 amount) public pure returns (uint256 potPart, uint256 burnPart) {
        burnPart = (amount * BURN_BPS) / BPS;
        potPart = amount - burnPart;
    }

    /// @notice Pot available to finalizeEpoch (excludes this week's inflow).
    function payablePot() public view returns (uint256) {
        return potInEpoch == currentEpoch() ? epochPot - potInCurrent : epochPot;
    }

    function linkDigest(bytes32 handleHash, address account, uint256 deadline) external view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(LINK_TYPEHASH, handleHash, account, handleNonce[handleHash], deadline))
            );
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // =================================================================== internal
    function _tip(address from, address creator, uint256 amount, bytes32 postId) internal {
        if (creator == address(0)) revert ZeroAddress();
        if (creator == from) revert SelfPayment();
        uint256 fee = _takeFee(amount);
        emit Tipped(from, creator, postId, amount, fee);
        wif.safeTransfer(creator, amount - fee);
    }

    function _priceOf(address creator, uint8 tier, uint8 plan) internal view returns (uint256 price) {
        if (tier >= MAX_TIERS) revert InvalidTier();
        if (plan > YEARLY) revert InvalidPlan();
        price = plan == YEARLY ? _yearlyPrice[creator][tier] : _tierPrice[creator][tier];
        if (price == 0) revert TierDisabled();
    }

    /// @dev Same tier within grace extends from the old expiry; otherwise a new period starts now.
    function _subscribe(address user, address creator, uint8 tier, uint8 plan, uint256 price) internal {
        if (creator == user) revert SelfPayment();
        Sub storage s = _subs[user][creator];
        uint256 start =
            (s.expiry != 0 && s.expiry + gracePeriod > block.timestamp && s.tier == tier) ? s.expiry : block.timestamp;
        uint64 expiry = uint64(start + (plan == YEARLY ? YEAR_PERIOD : SUB_PERIOD));
        s.expiry = expiry;
        s.tier = tier;
        s.plan = plan;
        uint256 fee = _takeFee(price);
        _credit(creator, price - fee);
        emit Subscribed(user, creator, tier, expiry, price, fee, msg.sender, plan);
    }

    function _checkTopSpotBid(uint256 amount) internal view {
        uint256 unlocksAt = topSpotUnlocksAt();
        if (block.timestamp < unlocksAt) revert TopSpotLocked(unlocksAt);
        uint256 minBid = minTopSpotBid();
        if (amount < minBid) revert BidTooLow(minBid);
    }

    /// @dev Previous holder is credited 90%; the rest (or all, if empty) goes through _splitFee.
    function _takeTopSpot(address user, bytes32 postId, uint256 amount) internal {
        address prev = topSpot.holder;
        uint256 toPrev = prev != address(0) ? (amount * TOP_SPOT_PREV_BPS) / BPS : 0;
        topSpot = TopSpot({holder: user, takenAt: uint64(block.timestamp), postId: postId, amount: amount});
        if (toPrev != 0) _credit(prev, toPrev);
        emit TopSpotTaken(user, postId, amount, prev, toPrev);
        _splitFee(amount - toPrev);
    }

    /// @dev Takes feeBps of `amount` and splits it. Returns the fee.
    function _takeFee(uint256 amount) internal returns (uint256 fee) {
        fee = (amount * feeBps) / BPS;
        _splitFee(fee);
    }

    /// @dev 90% (+ dust) to `epochPot`, 10% burned. WIF must already be held here.
    function _splitFee(uint256 amount) internal {
        if (amount == 0) return;
        (uint256 toPot, uint256 toBurn) = quoteSplit(amount);
        _addToPot(toPot);
        emit FeeSplit(toPot, toBurn);
        _burn(toBurn);
    }

    /// @dev Adds to the pot and tracks this week's inflow.
    function _addToPot(uint256 amount) internal {
        if (amount == 0) return;
        uint256 ep = currentEpoch();
        if (potInEpoch != ep) {
            potInEpoch = ep;
            potInCurrent = amount;
        } else {
            potInCurrent += amount;
        }
        epochPot += amount;
    }

    /// @notice The community pot (same as `epochPot`).
    function communityPot() external view returns (uint256) {
        return epochPot;
    }

    function _burn(uint256 amount) internal {
        if (amount == 0) return;
        totalBurned += amount;
        emit Burned(amount);
        if (useBurnFunction) IBurnableERC20(address(wif)).burn(amount);
        else wif.safeTransfer(DEAD, amount);
    }

    function _pull(address from, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        wif.safeTransferFrom(from, address(this), amount);
    }

    /// @dev Spend from `user`'s in-contract balance. msg.sender must be the user or their agent.
    function _spendBalance(address user, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        if (msg.sender != user) {
            Agent storage a = agents[user];
            if (a.agent == address(0) || a.agent != msg.sender) revert NotAuthorized();
            uint64 today = _today();
            uint256 spent = a.day == today ? a.spentToday : 0;
            spent += amount;
            if (spent > a.dailyCap) revert AgentCapExceeded();
            a.day = today;
            a.spentToday = uint128(spent); // <= dailyCap (uint128)
            emit AgentSpent(user, msg.sender, amount, spent);
        }
        _debit(user, amount);
    }

    function _debit(address user, uint256 amount) internal {
        uint256 bal = balances[user];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balances[user] = bal - amount;
            totalBalances -= amount;
        }
    }

    function _credit(address to, uint256 amount) internal {
        balances[to] += amount;
        totalBalances += amount;
    }

    function _withdraw(uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balances[msg.sender];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balances[msg.sender] = bal - amount;
            totalBalances -= amount;
        }
        emit Withdrawn(msg.sender, amount);
        wif.safeTransfer(msg.sender, amount);
    }

    function _today() internal view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }
}
