// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {MulticallUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/MulticallUpgradeable.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IBurnableERC20} from "./interfaces/IBurnableERC20.sol";
import {IWiflyNameRenderer} from "./interfaces/IWiflyNameRenderer.sol";
import {IWiflyPot} from "./interfaces/IWiflyPot.sol";
import {IWifToWifSwap} from "./interfaces/IWiflyPayments.sol";
import {UsdMath} from "./UsdMath.sol";

/// @title WiflyNames
/// @notice `.wif` names as ERC-721 tokens paid in $WIF, with resolver records and a built-in marketplace.
contract WiflyNames is
    Initializable,
    ERC721Upgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    MulticallUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 1_000; // 10%
    /// @notice Claim fee split: 50% treasury, 50% community pot.
    uint256 public constant CLAIM_TREASURY_BPS = 5_000;
    uint256 public constant CLAIM_POT_BPS = 5_000;
    /// @notice Sale fee split: 90% community pot, 10% burned.
    uint256 public constant SALE_POT_BPS = 9_000;
    uint256 public constant SALE_BURN_BPS = 1_000;
    uint256 public constant MIN_LEN = 2; // v2: 2-char names (open once claimFee2 is set)
    uint256 public constant MAX_LEN = 20;
    uint256 public constant SHORT_LEN = 4; // short-name art for 2-4 chars; 4 chars use `shortClaimFee`
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_KEY_LEN = 64; // text record key, bytes
    uint256 public constant MAX_TEXT_LEN = 256; // text record value, bytes
    uint8 public constant MAX_THEME = 2; // card theme: 0 = default, 1 = white, 2 = green

    IERC20 public wif;
    bool public useBurnFunction;

    uint256 public claimFee; // 5+ chars
    uint256 public shortClaimFee; // 4 chars (and 3 chars while claimFee3 is 0)
    uint256 public feeBps; // marketplace fee
    address public treasury;
    /// @notice Wifly community pot; if unset, the pot share goes to `treasury`.
    IWiflyPot public pot;
    /// @notice Once true, reserved names can no longer be minted.
    bool public reservationsLocked;
    uint256 public totalBurned;
    /// @notice On-chain art renderer; if unset, plain JSON metadata.
    IWiflyNameRenderer public renderer;
    /// @notice Once true, the renderer is frozen.
    bool public rendererLocked;

    struct Listing {
        address seller;
        uint256 price;
    }

    mapping(uint256 => string) internal _nameOf; // tokenId => name
    mapping(address => uint256) public primaryOf; // address => tokenId (0 = none)
    mapping(uint256 => Listing) public listings;
    /// @notice True for names minted with reserve().
    mapping(uint256 => bool) public isReserved;
    /// @notice Resolver record version; bumped on transfer to clear records.
    mapping(uint256 => uint256) public recordVersion;
    /// @notice Card theme: 0 = default, 1 = white, 2 = green. Kept across transfers.
    mapping(uint256 => uint8) public theme;
    mapping(uint256 => mapping(uint256 => address)) internal _addrs; // tokenId => version => addr
    mapping(uint256 => mapping(uint256 => mapping(string => string))) internal _texts; // tokenId => version => key => value

    // ---------------------------------------------------------------- v2 (appended; uses 3 gap slots)
    /// @notice 3-char claim fee; 0 = use shortClaimFee (legacy).
    uint256 public claimFee3;
    /// @notice 2-char claim fee; 0 = 2-char names closed.
    uint256 public claimFee2;
    /// @notice Deprecated: kept for storage layout; no longer used.
    address public paymentRouter;

    // ---------------------------------------------------------------- v3 checkout (appended; uses 3 gap slots)
    IERC20 public usdg;
    address public swapRouter;
    uint256 public usdgPerWif;

    /// @dev Reserved storage for future upgrades (50 - 3 - 3).
    uint256[44] private __gap;

    /// @notice `fee` is the claim fee paid (0 for reserved names).
    event NameClaimed(uint256 indexed tokenId, string name, address indexed owner, uint256 fee);
    /// @notice One fee split across treasury, pot and burn.
    event FeeSplit(uint256 treasuryAmount, uint256 potAmount, uint256 burnAmount);
    event PotSet(address pot);
    event PrimarySet(address indexed account, uint256 indexed tokenId);
    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event Delisted(uint256 indexed tokenId);
    event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee);
    event ClaimFeesSet(uint256 claimFee, uint256 shortClaimFee);
    /// @notice All four length tiers: 5+, 4, 3, 2 chars.
    event TierFeesSet(uint256 fee5, uint256 fee4, uint256 fee3, uint256 fee2);
    event PaymentRouterSet(address router);
    event UsdgSet(address token);
    event SwapRouterSet(address router);
    event UsdgPerWifSet(uint256 usdgPerWif);
    event NamePaid(address indexed payer, string name, address indexed to, address payToken, uint256 wifAmount);
    event FeeSet(uint256 feeBps);
    event TreasurySet(address treasury);
    event ReservationsLocked();
    event Burned(uint256 amount);
    event RendererSet(address renderer);
    event RendererLocked();
    /// @dev ERC-4906: tells marketplaces to refresh every token's metadata.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
    /// @notice Resolved address changed (address(0) = resolves to the owner).
    event AddrChanged(uint256 indexed tokenId, address addr);
    /// @notice Text record changed (empty value = deleted).
    event TextChanged(uint256 indexed tokenId, string indexed indexedKey, string key, string value);
    /// @notice Records cleared on transfer; `version` is the new record version.
    event RecordsCleared(uint256 indexed tokenId, uint256 version);
    /// @notice Card theme changed.
    event ThemeSet(uint256 indexed id, uint8 theme);
    /// @dev ERC-4906: tells marketplaces to refresh one token's metadata.
    event MetadataUpdate(uint256 _tokenId);

    error InvalidName();
    error NameTaken();
    error NotNameOwner();
    error NotListed();
    error ZeroAmount();
    error ZeroAddress();
    error FeeTooHigh();
    error PriceChanged(uint256 price);
    error SelfBuy();
    error Locked();
    error BadKey();
    error TextTooLong();
    error BadTheme();
    error TierClosed();
    error NotRouter();
    error SwapFailed();
    error InsufficientWif();

    address public constant USDG_ROBINHOOD = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Proxy initializer.
    function initialize(
        address wif_,
        bool useBurnFunction_,
        address owner_,
        address treasury_,
        uint256 claimFee_,
        uint256 shortClaimFee_
    ) external initializer {
        __ERC721_init("WIF Names", "WIFNAME");
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __Multicall_init();
        __UUPSUpgradeable_init();
        if (wif_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        wif = IERC20(wif_);
        useBurnFunction = useBurnFunction_;
        treasury = treasury_;
        claimFee = claimFee_;
        shortClaimFee = shortClaimFee_;
        feeBps = 250;
        emit TreasurySet(treasury_);
        emit ClaimFeesSet(claimFee_, shortClaimFee_);
    }

    /// @notice v2: set all four tier fees at upgrade time (run once via upgradeToAndCall).
    function initializeV2(uint256 fee5, uint256 fee4, uint256 fee3, uint256 fee2) external reinitializer(2) onlyOwner {
        _setTierFees(fee5, fee4, fee3, fee2);
    }

    /// @notice v3: USDG / ETH claim checkout (run once via upgradeToAndCall).
    function initializeV3() external reinitializer(3) onlyOwner {
        usdg = IERC20(USDG_ROBINHOOD);
        usdgPerWif = 0;
        emit UsdgSet(USDG_ROBINHOOD);
        emit UsdgPerWifSet(usdgPerWif);
    }

    /// @dev UUPS: only the owner can upgrade.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // =================================================================== claim
    /// @notice Claim an unused name; becomes your primary name if you have none.
    function claim(string calldata name) external nonReentrant whenNotPaused returns (uint256 tokenId) {
        string memory label = toLabel(name);
        uint256 fee = _feeOf(label); // validates
        tokenId = _mintName(label, msg.sender);
        if (fee != 0) {
            wif.safeTransferFrom(msg.sender, address(this), fee);
            (uint256 toTreasury, uint256 toPot) = quoteClaimSplit(fee);
            _payOut(toTreasury, toPot, 0);
        }
        emit NameClaimed(tokenId, label, msg.sender, fee);
    }

    /// @notice Internal-only mint after off-chain-router migration; do not call.
    function claimFor(string calldata name, address to) external nonReentrant whenNotPaused returns (uint256 tokenId) {
        if (msg.sender != address(this)) revert NotRouter();
        if (to == address(0)) revert ZeroAddress();
        string memory label = toLabel(name);
        _feeOf(label);
        tokenId = _mintName(label, to);
        emit NameClaimed(tokenId, label, to, 0);
    }

    function setUsdg(address token) external onlyOwner {
        usdg = IERC20(token);
        emit UsdgSet(token);
    }

    function setSwapRouter(address router) external onlyOwner {
        swapRouter = router;
        emit SwapRouterSet(router);
    }

    function setUsdgPerWif(uint256 rate) external onlyOwner {
        if (rate == 0) revert ZeroAmount();
        usdgPerWif = rate;
        emit UsdgPerWifSet(rate);
    }

    function quoteUsdgForWif(uint256 wifWei) external view returns (uint256) {
        return UsdMath.usdgForWif(wifWei, usdgPerWif);
    }

    function payClaimUsdg(string calldata name, address to, uint256 usdgAmount) external nonReentrant whenNotPaused {
        if (usdgAmount == 0) revert ZeroAmount();
        if (address(usdg) == address(0)) revert ZeroAddress();
        string memory label = toLabel(name);
        uint256 fee = _feeOf(label);
        usdg.safeTransferFrom(msg.sender, address(this), usdgAmount);
        uint256 got = _swapUsdgForWif(usdgAmount);
        if (got < fee) revert InsufficientWif();
        address beneficiary = to == address(0) ? msg.sender : to;
        _payoutClaimFee(fee);
        uint256 tokenId = _mintName(label, beneficiary);
        emit NameClaimed(tokenId, label, beneficiary, fee);
        emit NamePaid(msg.sender, label, beneficiary, address(usdg), fee);
        if (got > fee) _refundWif(got - fee);
    }

    function payClaimEth(string calldata name, address to) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        string memory label = toLabel(name);
        uint256 fee = _feeOf(label);
        uint256 got = _swapEthForWif(msg.value);
        if (got < fee) revert InsufficientWif();
        address beneficiary = to == address(0) ? msg.sender : to;
        _payoutClaimFee(fee);
        uint256 tokenId = _mintName(label, beneficiary);
        emit NameClaimed(tokenId, label, beneficiary, fee);
        emit NamePaid(msg.sender, label, beneficiary, address(0), fee);
        if (got > fee) _refundWif(got - fee);
        _refundEth();
    }

    /// @notice Owner mints a reserved name for free, until `lockReservations`.
    function reserve(string calldata name, address to) external onlyOwner returns (uint256 tokenId) {
        if (reservationsLocked) revert Locked();
        if (to == address(0)) revert ZeroAddress();
        string memory label = toLabel(name);
        if (!isValidName(label)) revert InvalidName();
        tokenId = _mintName(label, to);
        isReserved[tokenId] = true;
        emit NameClaimed(tokenId, label, to, 0);
    }

    function setPrimary(uint256 tokenId) external {
        if (tokenId != 0 && _ownerOf(tokenId) != msg.sender) revert NotNameOwner();
        primaryOf[msg.sender] = tokenId;
        emit PrimarySet(msg.sender, tokenId);
    }

    // =================================================================== resolver records
    /// @notice Point your name at `a` (address(0) = resolve to the owner).
    function setAddr(uint256 tokenId, address a) external {
        if (_ownerOf(tokenId) != msg.sender) revert NotNameOwner();
        _addrs[tokenId][recordVersion[tokenId]] = a;
        emit AddrChanged(tokenId, a);
    }

    /// @notice Set a text record on your name; empty `value` deletes it.
    function setText(uint256 tokenId, string calldata key, string calldata value) external {
        if (_ownerOf(tokenId) != msg.sender) revert NotNameOwner();
        if (bytes(key).length == 0 || bytes(key).length > MAX_KEY_LEN) revert BadKey();
        if (bytes(value).length > MAX_TEXT_LEN) revert TextTooLong();
        _texts[tokenId][recordVersion[tokenId]][key] = value;
        emit TextChanged(tokenId, key, key, value);
    }

    // =================================================================== card theme
    /// @notice Set your card theme: 0 = default, 1 = white, 2 = green.
    function setTheme(uint256 id, uint8 t) external {
        if (_ownerOf(id) != msg.sender) revert NotNameOwner();
        if (t > MAX_THEME) revert BadTheme();
        theme[id] = t;
        emit ThemeSet(id, t);
        emit MetadataUpdate(id);
    }

    // =================================================================== marketplace
    /// @notice List (or re-price) a name you own. Price in WIF wei.
    function list(uint256 tokenId, uint256 price) external whenNotPaused {
        if (_ownerOf(tokenId) != msg.sender) revert NotNameOwner();
        if (price == 0) revert ZeroAmount();
        listings[tokenId] = Listing({seller: msg.sender, price: price});
        emit Listed(tokenId, msg.sender, price);
    }

    function cancel(uint256 tokenId) external {
        if (listings[tokenId].seller != msg.sender) revert NotListed();
        delete listings[tokenId];
        emit Delisted(tokenId);
    }

    /// @notice Buy a listed name; `maxPrice` guards against price changes.
    function buy(uint256 tokenId, uint256 maxPrice) external nonReentrant whenNotPaused {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0) || _ownerOf(tokenId) != l.seller) revert NotListed();
        if (l.price > maxPrice) revert PriceChanged(l.price);
        if (l.seller == msg.sender) revert SelfBuy();
        uint256 fee = (l.price * feeBps) / BPS;

        _transfer(l.seller, msg.sender, tokenId); // clears the listing in _update
        if (primaryOf[msg.sender] == 0) _setPrimary(msg.sender, tokenId);
        emit Sold(tokenId, l.seller, msg.sender, l.price, fee);

        wif.safeTransferFrom(msg.sender, l.seller, l.price - fee);
        if (fee != 0) {
            wif.safeTransferFrom(msg.sender, address(this), fee);
            (uint256 toPot, uint256 toBurn) = quoteSplit(fee);
            _payOut(0, toPot, toBurn);
        }
    }

    // =================================================================== owner
    function setClaimFees(uint256 claimFee_, uint256 shortClaimFee_) external onlyOwner {
        claimFee = claimFee_;
        shortClaimFee = shortClaimFee_;
        emit ClaimFeesSet(claimFee_, shortClaimFee_);
    }

    /// @notice Set every length tier: 5+, 4, 3, 2 chars. fee2 = 0 closes 2-char names.
    function setTierFees(uint256 fee5, uint256 fee4, uint256 fee3, uint256 fee2) external onlyOwner {
        _setTierFees(fee5, fee4, fee3, fee2);
    }

    function _setTierFees(uint256 fee5, uint256 fee4, uint256 fee3, uint256 fee2) internal {
        claimFee = fee5;
        shortClaimFee = fee4;
        claimFee3 = fee3;
        claimFee2 = fee2;
        emit ClaimFeesSet(fee5, fee4);
        emit TierFeesSet(fee5, fee4, fee3, fee2);
    }

    function setPaymentRouter(address router) external onlyOwner {
        paymentRouter = router;
        emit PaymentRouterSet(router);
    }

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

    /// @notice Set the community pot (address(0) = pot share to `treasury`).
    function setPot(address newPot) external onlyOwner {
        pot = IWiflyPot(newPot);
        emit PotSet(newPot);
    }

    /// @notice Set the art renderer (address(0) = plain JSON).
    function setRenderer(address newRenderer) external onlyOwner {
        if (rendererLocked) revert Locked();
        renderer = IWiflyNameRenderer(newRenderer);
        emit RendererSet(newRenderer);
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    /// @notice Freeze the current renderer forever.
    function lockRenderer() external onlyOwner {
        if (address(renderer) == address(0)) revert ZeroAddress();
        rendererLocked = true;
        emit RendererLocked();
    }

    function lockReservations() external onlyOwner {
        reservationsLocked = true;
        emit ReservationsLocked();
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // =================================================================== views
    /// @notice Bare label of `name` (strips one trailing ".wif").
    function toLabel(string calldata name) public pure returns (string memory) {
        bytes calldata b = bytes(name);
        uint256 n = b.length;
        if (n > 4 && b[n - 4] == "." && b[n - 3] == "w" && b[n - 2] == "i" && b[n - 1] == "f") {
            return string(b[:n - 4]);
        }
        return name;
    }

    /// @notice True if `name` is a bare label of 2-20 bytes of [a-z0-9_].
    function isValidName(string memory name) public pure returns (bool) {
        bytes memory b = bytes(name);
        if (b.length < MIN_LEN || b.length > MAX_LEN) return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f)) return false;
        }
        return true;
    }

    /// @notice Claim fee for a name, with or without ".wif" (reverts if the name is invalid).
    function claimFeeOf(string calldata name) external view returns (uint256) {
        return _feeOf(toLabel(name));
    }

    /// @notice Token id of a name, with or without ".wif".
    function idOf(string calldata name) public pure returns (uint256) {
        return _id(toLabel(name));
    }

    function isAvailable(string calldata name) external view returns (bool) {
        string memory label = toLabel(name);
        if (!isValidName(label) || _ownerOf(_id(label)) != address(0)) return false;
        return bytes(label).length != 2 || claimFee2 != 0; // 2-char tier must be open
    }

    /// @notice Owner of a name, or address(0) if unclaimed.
    function ownerOfName(string calldata name) external view returns (address) {
        return _ownerOf(idOf(name));
    }

    /// @notice Forward resolution by token id: the set addr, else the owner; address(0) if unclaimed.
    function addrOf(uint256 tokenId) public view returns (address) {
        address o = _ownerOf(tokenId);
        if (o == address(0)) return address(0);
        address a = _addrs[tokenId][recordVersion[tokenId]];
        return a == address(0) ? o : a;
    }

    /// @notice Forward resolution by name (address(0) if unclaimed or invalid).
    function addr(string calldata name) external view returns (address) {
        return addrOf(idOf(name));
    }

    /// @notice Same as `addr`, for full names.
    function resolve(string calldata fullName) external view returns (address) {
        return addrOf(idOf(fullName));
    }

    /// @notice Text record by token id ("" if unset or unclaimed).
    function textOf(uint256 tokenId, string calldata key) public view returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) return "";
        return _texts[tokenId][recordVersion[tokenId]][key];
    }

    /// @notice Text record by name ("" if unset or unclaimed).
    function text(string calldata name, string calldata key) external view returns (string memory) {
        return textOf(idOf(name), key);
    }

    /// @notice Reverse resolution: the primary name if it still resolves to `account`, else "".
    function reverseName(address account) external view returns (string memory) {
        uint256 id = primaryOf[account];
        if (id == 0 || addrOf(id) != account) return "";
        return string.concat(_nameOf[id], ".wif");
    }

    /// @notice The name behind a token id ("" if none).
    function nameOfToken(uint256 tokenId) external view returns (string memory) {
        return _nameOf[tokenId];
    }

    /// @notice Unverified primary label of `account`; use `reverseName` to display.
    function nameOf(address account) external view returns (string memory) {
        return _nameOf[primaryOf[account]];
    }

    /// @notice Sale preview: (fee, pot part, burned part, net to seller).
    function quoteSale(uint256 price) external view returns (uint256 fee, uint256 potPart, uint256 burnPart, uint256 net) {
        fee = (price * feeBps) / BPS;
        (potPart, burnPart) = quoteSplit(fee);
        net = price - fee;
    }

    /// @notice Sale fee split: 10% burned (rounded down), the rest to the pot.
    function quoteSplit(uint256 amount) public pure returns (uint256 potPart, uint256 burnPart) {
        burnPart = (amount * SALE_BURN_BPS) / BPS;
        potPart = amount - burnPart;
    }

    /// @notice Claim fee split: 50% treasury (rounded down), the rest to the pot.
    function quoteClaimSplit(uint256 amount) public pure returns (uint256 treasuryPart, uint256 potPart) {
        treasuryPart = (amount * CLAIM_TREASURY_BPS) / BPS;
        potPart = amount - treasuryPart;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory n = _nameOf[tokenId];
        if (address(renderer) != address(0)) {
            return renderer.tokenURI(tokenId, n, bytes(n).length <= SHORT_LEN, isReserved[tokenId], theme[tokenId]);
        }
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(
                bytes(
                    string.concat('{"name":"', n, '.wif","description":"', n, '.wif, a WIF Name on Robinhood Chain."}')
                )
            )
        );
    }

    /// @notice ERC-2981: outside marketplaces pay the same resale fee to the treasury.
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (treasury, (salePrice * feeBps) / BPS);
    }

    /// @dev ERC-4906 (metadata update events) and ERC-2981 (royalties).
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == 0x49064906 || interfaceId == 0x2a55205a || super.supportsInterface(interfaceId);
    }

    // =================================================================== internal
    function _feeOf(string memory label) internal view returns (uint256) {
        if (!isValidName(label)) revert InvalidName();
        uint256 len = bytes(label).length;
        if (len == 2) {
            if (claimFee2 == 0) revert TierClosed(); // 2-char opens only once priced
            return claimFee2;
        }
        if (len == 3 && claimFee3 != 0) return claimFee3;
        return len <= SHORT_LEN ? shortClaimFee : claimFee;
    }

    function _id(string memory label) internal pure returns (uint256) {
        return uint256(keccak256(bytes(label)));
    }

    function _mintName(string memory name, address to) internal returns (uint256 tokenId) {
        tokenId = _id(name);
        if (_ownerOf(tokenId) != address(0)) revert NameTaken();
        _nameOf[tokenId] = name;
        _mint(to, tokenId);
        if (primaryOf[to] == 0) _setPrimary(to, tokenId);
    }

    function _setPrimary(address account, uint256 tokenId) internal {
        primaryOf[account] = tokenId;
        emit PrimarySet(account, tokenId);
    }

    /// @dev Transfers clear the listing, the sender's primary (if this token) and resolver records.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (listings[tokenId].seller != address(0)) {
            delete listings[tokenId];
            emit Delisted(tokenId);
        }
        if (from != address(0) && primaryOf[from] == tokenId) {
            primaryOf[from] = 0;
            emit PrimarySet(from, 0);
        }
        if (from != address(0)) emit RecordsCleared(tokenId, ++recordVersion[tokenId]);
    }

    /// @dev Burn, fund the pot (treasury if unset) and pay the treasury.
    function _payOut(uint256 toTreasury, uint256 toPot, uint256 toBurn) internal {
        emit FeeSplit(toTreasury, toPot, toBurn);
        _burnWif(toBurn);
        IWiflyPot p = pot;
        if (address(p) == address(0)) {
            toTreasury += toPot;
        } else if (toPot != 0) {
            wif.forceApprove(address(p), toPot);
            p.fundPot(toPot);
        }
        if (toTreasury != 0) wif.safeTransfer(treasury, toTreasury);
    }

    function _burnWif(uint256 amount) internal {
        if (amount == 0) return;
        totalBurned += amount;
        emit Burned(amount);
        if (useBurnFunction) IBurnableERC20(address(wif)).burn(amount);
        else wif.safeTransfer(DEAD, amount);
    }

    function _payoutClaimFee(uint256 fee) internal {
        (uint256 toTreasury, uint256 toPot) = quoteClaimSplit(fee);
        _payOut(toTreasury, toPot, 0);
    }

    function _swapUsdgForWif(uint256 usdgAmount) internal returns (uint256 wifOut) {
        if (swapRouter == address(0)) revert SwapFailed();
        usdg.forceApprove(swapRouter, usdgAmount);
        uint256 before = wif.balanceOf(address(this));
        wifOut = IWifToWifSwap(swapRouter).swapTokenForWif(address(usdg), usdgAmount, 0);
        if (wifOut == 0) wifOut = wif.balanceOf(address(this)) - before;
    }

    function _swapEthForWif(uint256 ethIn) internal returns (uint256 wifOut) {
        if (swapRouter == address(0)) revert SwapFailed();
        uint256 before = wif.balanceOf(address(this));
        wifOut = IWifToWifSwap(swapRouter).swapEthForWif{value: ethIn}(0);
        if (wifOut == 0) wifOut = wif.balanceOf(address(this)) - before;
    }

    function _refundWif(uint256 amount) internal {
        if (amount != 0) wif.safeTransfer(msg.sender, amount);
    }

    function _refundEth() internal {
        uint256 bal = address(this).balance;
        if (bal != 0) {
            (bool ok,) = msg.sender.call{value: bal}("");
            if (!ok) revert SwapFailed();
        }
    }

    receive() external payable {}
}
