// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {WiflyBadges} from "../src/WiflyBadges.sol";
import {Wifly} from "../src/Wifly.sol";
import {MockWIF} from "./mocks/MockWIF.sol";
import {Proxies} from "./utils/Proxies.sol";

contract ExtrasHandler is Test {
    WiflyNames internal n;
    WiflyBadges internal b;
    MockWIF internal token;
    address internal owner;

    address[] public actors;
    uint256[] public ids;
    string[8] internal pool = ["alpha", "bravo", "cat", "dog_1", "echo", "fox", "golf_99", "wif"];
    bool public ghostBadgeMoved;
    uint256 public ghostBurnedForBadges;
    // resolver ghosts: record generation the handler last wrote at, and what it wrote
    mapping(uint256 => uint256) public ghostRecVersion;
    mapping(uint256 => bool) public ghostWrote;
    mapping(uint256 => address) public ghostAddr;
    mapping(uint256 => string) internal _ghostX;

    constructor(WiflyNames n_, WiflyBadges b_, MockWIF token_, address owner_) {
        n = n_;
        b = b_;
        token = token_;
        owner = owner_;
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string(abi.encodePacked("xactor", vm.toString(i))));
            actors.push(a);
            token.mint(a, 1e30);
            vm.startPrank(a);
            token.approve(address(n), type(uint256).max);
            token.approve(address(b), type(uint256).max);
            vm.stopPrank();
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function claim(uint256 s, uint256 k) external {
        string memory name = pool[k % pool.length];
        if (!n.isAvailable(name)) return;
        vm.prank(_actor(s));
        ids.push(n.claim(name));
    }

    function list(uint256 s, uint256 price) external {
        if (ids.length == 0) return;
        uint256 id = ids[s % ids.length];
        address o = n.ownerOf(id);
        vm.prank(o);
        n.list(id, bound(price, 1, 1e24));
    }

    function cancel(uint256 s) external {
        if (ids.length == 0) return;
        uint256 id = ids[s % ids.length];
        (address seller,) = n.listings(id);
        if (seller == address(0)) return;
        vm.prank(seller);
        n.cancel(id);
    }

    function buy(uint256 s, uint256 who) external {
        if (ids.length == 0) return;
        uint256 id = ids[s % ids.length];
        (address seller, uint256 price) = n.listings(id);
        address buyer = _actor(who);
        if (seller == address(0) || buyer == seller) return;
        vm.prank(buyer);
        n.buy(id, price);
    }

    function transfer(uint256 s, uint256 to) external {
        if (ids.length == 0) return;
        uint256 id = ids[s % ids.length];
        address o = n.ownerOf(id);
        vm.prank(o);
        n.transferFrom(o, _actor(to), id);
    }

    function setPrimary(uint256 s, uint256 k) external {
        address a = _actor(s);
        uint256 bal = n.balanceOf(a);
        if (bal == 0) return;
        // pick a token a owns
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[(k % ids.length + i) % ids.length];
            if (n.ownerOf(id) == a) {
                vm.prank(a);
                n.setPrimary(id);
                return;
            }
        }
    }

    function setAddr(uint256 s, uint256 to) external {
        if (ids.length == 0) return;
        uint256 id = ids[s % ids.length];
        address o = n.ownerOf(id);
        // mostly other actors (breaks the reverse round trip), sometimes self or zero
        address a = to % 5 == 0 ? address(0) : to % 5 == 1 ? o : _actor(to);
        _syncGhost(id);
        vm.prank(o);
        n.setAddr(id, a);
        ghostAddr[id] = a;
    }

    function setText(uint256 s, uint256 v) external {
        if (ids.length == 0) return;
        uint256 id = ids[s % ids.length];
        address o = n.ownerOf(id);
        string memory val = v % 4 == 0 ? "" : vm.toString(v);
        _syncGhost(id);
        vm.prank(o);
        n.setText(id, "x", val);
        _ghostX[id] = val;
    }

    function ghostX(uint256 id) external view returns (string memory) {
        return _ghostX[id];
    }

    /// @dev Start a fresh ghost record set when the on-chain generation moved on (token was transferred).
    function _syncGhost(uint256 id) internal {
        uint256 v = n.recordVersion(id);
        if (!ghostWrote[id] || ghostRecVersion[id] != v) {
            ghostWrote[id] = true;
            ghostRecVersion[id] = v;
            ghostAddr[id] = address(0);
            _ghostX[id] = "";
        }
    }

    function burnForBadges(uint256 s, uint256 amt) external {
        amt = bound(amt, 1, 5_000e18);
        vm.prank(_actor(s));
        b.burn(amt);
        ghostBurnedForBadges += amt;
    }

    function tryMoveBadge(uint256 s, uint256 id) external {
        address from = _actor(s);
        id = bound(id, 0, 3);
        vm.prank(from);
        try b.safeTransferFrom(from, actors[(s % actors.length + 1) % actors.length], id, 1, "") {
            ghostBadgeMoved = true;
        } catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }
}

contract WiflyExtrasInvariantTest is Test {
    WiflyNames internal n;
    WiflyBadges internal b;
    MockWIF internal token;
    ExtrasHandler internal h;
    Wifly internal w; // community pot for the names' pot share
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        token = new MockWIF();
        address owner = makeAddr("owner");
        n = Proxies.names(address(token), true, owner, treasury, 10e18, 50e18);
        w = Proxies.wifly(address(token), true, owner, makeAddr("attester"), makeAddr("wiflyTreasury"), 100e18);
        vm.prank(owner);
        n.setPot(address(w));
        uint256[] memory t = new uint256[](4);
        t[0] = 100e18;
        t[1] = 1_000e18;
        t[2] = 10_000e18;
        t[3] = 50_000e18;
        b = Proxies.badges(address(token), true, owner, "", t);
        h = new ExtrasHandler(n, b, token, owner);
        targetContract(address(h));
    }

    /// @dev Names are unique: every claimed id maps back to its own name and has exactly one owner, and
    ///      total balances equal the number of names.
    function invariant_namesUnique() public view {
        uint256 total;
        uint256 count = h.idCount();
        for (uint256 i; i < count; ++i) {
            uint256 id = h.ids(i);
            assertEq(n.idOf(n.nameOfToken(id)), id);
            assertTrue(n.ownerOf(id) != address(0));
        }
        for (uint256 i; i < h.actorCount(); ++i) {
            total += n.balanceOf(h.actors(i));
        }
        assertEq(total, count);
    }

    /// @dev No listing survives a transfer: any live listing's seller is the current owner.
    function invariant_noStaleListing() public view {
        uint256 count = h.idCount();
        for (uint256 i; i < count; ++i) {
            uint256 id = h.ids(i);
            (address seller,) = n.listings(id);
            if (seller != address(0)) assertEq(seller, n.ownerOf(id));
        }
    }

    /// @dev A primary name is always owned by the account it points from.
    function invariant_primaryOwned() public view {
        for (uint256 i; i < h.actorCount(); ++i) {
            address a = h.actors(i);
            uint256 id = n.primaryOf(a);
            if (id != 0) assertEq(n.ownerOf(id), a);
        }
    }

    /// @dev Reverse resolution is always consistent: a non-empty reverseName(a) is owned by a's primary token and
    ///      forward-resolves back to a. And if a's primary resolves to a, reverseName(a) is exactly "label.wif".
    function invariant_reverseConsistent() public view {
        for (uint256 i; i < h.actorCount(); ++i) {
            address a = h.actors(i);
            string memory r = n.reverseName(a);
            uint256 p = n.primaryOf(a);
            if (bytes(r).length != 0) {
                assertEq(n.resolve(r), a);
                assertEq(n.ownerOfName(r), a);
                assertEq(n.idOf(r), p);
                assertEq(r, string.concat(n.nameOfToken(p), ".wif"));
            } else {
                assertTrue(p == 0 || n.addrOf(p) != a);
            }
        }
    }

    /// @dev Records never outlive a transfer, and while the generation is unchanged they are exactly what the
    ///      owner wrote. Forward resolution of a claimed name is never address(0).
    function invariant_recordsClearedOnTransfer() public view {
        uint256 count = h.idCount();
        for (uint256 i; i < count; ++i) {
            uint256 id = h.ids(i);
            address o = n.ownerOf(id);
            assertTrue(n.addrOf(id) != address(0));
            if (!h.ghostWrote(id) || h.ghostRecVersion(id) != n.recordVersion(id)) {
                assertEq(n.addrOf(id), o, "stale addr");
                assertEq(n.textOf(id, "x"), "", "stale text");
            } else {
                address g = h.ghostAddr(id);
                assertEq(n.addrOf(id), g == address(0) ? o : g);
                assertEq(n.textOf(id, "x"), h.ghostX(id));
            }
        }
    }

    /// @dev The names contract never holds WIF (fees are burned or forwarded in the same tx).
    function invariant_namesHoldsNoWif() public view {
        assertEq(token.balanceOf(address(n)), 0);
    }

    /// @dev Badges never move, each is held at most once, and holding one <=> cumulative burn >= threshold.
    function invariant_badgesSoulboundAndExact() public view {
        assertFalse(h.ghostBadgeMoved());
        uint256 sumBurned;
        uint256[] memory t = b.allThresholds();
        for (uint256 i; i < h.actorCount(); ++i) {
            address a = h.actors(i);
            sumBurned += b.burnedBy(a);
            for (uint256 j; j < t.length; ++j) {
                assertEq(b.balanceOf(a, j), b.burnedBy(a) >= t[j] ? 1 : 0);
            }
        }
        assertEq(sumBurned, h.ghostBurnedForBadges());
        assertEq(b.totalBurned(), sumBurned);
        assertEq(token.balanceOf(address(b)), 0);
    }

    /// @dev Names fees: claims 50% treasury / 50% pot (no burn), sales 90% pot / 10% burned.
    function invariant_namesFeeSplit() public view {
        uint256 burned = n.totalBurned();
        assertEq(token.balanceOf(address(w)), w.epochPot());
        assertGe(w.epochPot(), 9 * burned);
        assertGe(w.epochPot(), token.balanceOf(treasury)); // pot share (50% + dust, 90%) >= treasury share
        assertEq(token.allowance(address(n), address(w)), 0);
    }

    /// @dev Supply only drops by what was burned (names fees + badge burns).
    function invariant_burnAccounting() public view {
        assertEq(token.totalSupply() + n.totalBurned() + b.totalBurned(), 4 * 1e30);
    }
}
