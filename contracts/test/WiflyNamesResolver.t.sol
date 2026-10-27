// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {WiflyGlyphs} from "../src/render/WiflyGlyphs.sol";
import {MockWIF} from "./mocks/MockWIF.sol";
import {Proxies} from "./utils/Proxies.sol";

/// @notice ".wif" presentation, suffix handling and the resolver (addr / text / reverse).
contract WiflyNamesResolverTest is Test {
    WiflyNames internal n;
    MockWIF internal token;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal hot = makeAddr("hot");

    event AddrChanged(uint256 indexed tokenId, address addr);
    event TextChanged(uint256 indexed tokenId, string indexed indexedKey, string key, string value);
    event RecordsCleared(uint256 indexed tokenId, uint256 version);

    function setUp() public {
        token = new MockWIF();
        n = Proxies.names(address(token), true, owner, treasury, 100e18, 1_000e18);
        address[2] memory users = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            token.mint(users[i], 1_000_000e18);
            vm.prank(users[i]);
            token.approve(address(n), type(uint256).max);
        }
    }

    function _claim(address who, string memory name) internal returns (uint256 id) {
        vm.prank(who);
        id = n.claim(name);
    }

    function _records(address who, uint256 id) internal {
        vm.startPrank(who);
        n.setAddr(id, hot);
        n.setText(id, "avatar", "data:image/png;base64,AAAA");
        n.setText(id, "x", "marv");
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- presentation + suffix
    function test_collectionNameSymbol() public view {
        assertEq(n.name(), "WIF Names");
        assertEq(n.symbol(), "WIFNAME");
    }

    function test_toLabel() public view {
        assertEq(n.toLabel("marv.wif"), "marv");
        assertEq(n.toLabel("marv"), "marv");
        assertEq(n.toLabel("wif.wif"), "wif");
        assertEq(n.toLabel("marv.wif.wif"), "marv.wif"); // only one suffix stripped -> invalid label
        assertEq(n.toLabel(".wif"), ".wif");
        assertEq(n.toLabel("marv.WIF"), "marv.WIF"); // exact lowercase only
        assertEq(n.toLabel(""), "");
    }

    function test_claim_withSuffix_storesBareLabel() public {
        uint256 id = _claim(alice, "marv.wif");
        assertEq(id, uint256(keccak256("marv")));
        assertEq(n.idOf("marv.wif"), n.idOf("marv"));
        assertEq(n.nameOfToken(id), "marv");
        assertEq(n.ownerOfName("marv.wif"), alice);
        assertEq(n.ownerOfName("marv"), alice);
        assertFalse(n.isAvailable("marv"));
        assertFalse(n.isAvailable("marv.wif"));
        assertEq(token.balanceOf(alice), 1_000_000e18 - 1_000e18, "short fee by bare length");
        // the same name without suffix is taken
        vm.prank(bob);
        vm.expectRevert(WiflyNames.NameTaken.selector);
        n.claim("marv");
    }

    function test_suffix_invalidForms() public {
        assertEq(n.claimFeeOf("alice.wif"), 100e18);
        assertEq(n.claimFeeOf("wif.wif"), 1_000e18);
        vm.startPrank(alice);
        vm.expectRevert(WiflyNames.InvalidName.selector);
        n.claim("ab.wif"); // label too short
        vm.expectRevert(WiflyNames.InvalidName.selector);
        n.claim("marv.wif.wif");
        vm.expectRevert(WiflyNames.InvalidName.selector);
        n.claim("marv.WIF");
        vm.expectRevert(WiflyNames.InvalidName.selector);
        n.claim(".wif");
        vm.stopPrank();
        assertFalse(n.isAvailable("ab.wif"));
        assertTrue(n.isAvailable("abcdefghijklmnopqrst.wif")); // 20-char label + suffix
        assertFalse(n.isValidName("marv.wif"), "isValidName checks the bare label");
    }

    function test_reserve_withSuffix() public {
        vm.prank(owner);
        uint256 id = n.reserve("wifly.wif", owner);
        assertEq(n.nameOfToken(id), "wifly");
        assertTrue(n.isReserved(id));
        assertEq(n.reverseName(owner), "wifly.wif");
    }

    function test_tokenURI_fallback_showsDotWif() public {
        uint256 id = _claim(alice, "marv");
        string memory j = string(_b64decodeJson(n.tokenURI(id)));
        assertEq(vm.parseJsonString(j, ".name"), "marv.wif");
    }

    function _b64decodeJson(string memory uri) internal pure returns (bytes memory) {
        // the fallback JSON is short and fixed: compare against the expected encoding instead of decoding
        bytes memory expected = bytes('{"name":"marv.wif","description":"marv.wif, a WIF Name on Robinhood Chain."}');
        assertEq(uri, string.concat("data:application/json;base64,", vm.toBase64(expected)));
        return expected;
    }

    // ---------------------------------------------------------------- addr
    function test_addr_defaultsToOwner_thenSet_thenReset() public {
        uint256 id = _claim(alice, "marv");
        assertEq(n.addr("marv"), alice);
        assertEq(n.resolve("marv.wif"), alice);
        assertEq(n.addrOf(id), alice);

        vm.expectEmit(address(n));
        emit AddrChanged(id, hot);
        vm.prank(alice);
        n.setAddr(id, hot);
        assertEq(n.resolve("marv.wif"), hot);
        assertEq(n.addr("marv"), hot);

        vm.prank(alice);
        n.setAddr(id, address(0));
        assertEq(n.resolve("marv.wif"), alice, "zero = back to owner");
    }

    function test_unclaimedOrInvalid_resolveToZero() public view {
        assertEq(n.resolve("nobody.wif"), address(0));
        assertEq(n.resolve("Not Valid!"), address(0));
        assertEq(n.addrOf(123), address(0));
        assertEq(n.text("nobody.wif", "avatar"), "");
        assertEq(n.reverseName(alice), "");
    }

    function test_records_ownerOnly() public {
        uint256 id = _claim(alice, "marv");
        vm.startPrank(bob);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.setAddr(id, bob);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.setText(id, "url", "https://evil.example");
        vm.stopPrank();

        // an approved operator is not the owner either
        vm.prank(alice);
        n.setApprovalForAll(bob, true);
        vm.startPrank(bob);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.setAddr(id, bob);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.setText(id, "url", "x");
        vm.stopPrank();

        // unminted token
        vm.prank(alice);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.setAddr(456, alice);
    }

    // ---------------------------------------------------------------- text
    function test_text_set_read_delete() public {
        uint256 id = _claim(alice, "marv");
        vm.expectEmit(address(n));
        emit TextChanged(id, "bio", "bio", "gm from robinhood chain");
        vm.prank(alice);
        n.setText(id, "bio", "gm from robinhood chain");
        assertEq(n.text("marv.wif", "bio"), "gm from robinhood chain");
        assertEq(n.text("marv", "bio"), "gm from robinhood chain");
        assertEq(n.textOf(id, "bio"), "gm from robinhood chain");
        assertEq(n.text("marv.wif", "x"), "");
        vm.prank(alice);
        n.setText(id, "bio", "");
        assertEq(n.text("marv.wif", "bio"), "");
    }

    function test_text_lengthCaps() public {
        uint256 id = _claim(alice, "marv");
        bytes memory v256 = new bytes(256);
        bytes memory k64 = new bytes(64);
        for (uint256 i; i < 256; ++i) {
            v256[i] = "a";
            if (i < 64) k64[i] = "k";
        }
        vm.startPrank(alice);
        n.setText(id, string(k64), string(v256)); // exactly at both caps
        assertEq(n.text("marv", string(k64)), string(v256));

        vm.expectRevert(WiflyNames.TextTooLong.selector);
        n.setText(id, "bio", string(bytes.concat(v256, "a")));
        vm.expectRevert(WiflyNames.BadKey.selector);
        n.setText(id, string(bytes.concat(k64, "k")), "v");
        vm.expectRevert(WiflyNames.BadKey.selector);
        n.setText(id, "", "v");
        vm.stopPrank();
    }

    function testFuzz_text_cap(uint16 len) public {
        uint256 id = _claim(alice, "marv");
        len = uint16(bound(len, 0, 600));
        bytes memory v = new bytes(len);
        vm.prank(alice);
        if (len > 256) vm.expectRevert(WiflyNames.TextTooLong.selector);
        n.setText(id, "bio", string(v));
    }

    function test_multicall_setsAllRecordsInOneTx() public {
        uint256 id = _claim(alice, "marv");
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(WiflyNames.setAddr, (id, hot));
        calls[1] = abi.encodeCall(WiflyNames.setText, (id, "x", "marv"));
        calls[2] = abi.encodeCall(WiflyNames.setText, (id, "url", "https://wifly.app/marv"));
        vm.prank(alice);
        n.multicall(calls);
        assertEq(n.resolve("marv.wif"), hot);
        assertEq(n.text("marv.wif", "x"), "marv");
        assertEq(n.text("marv.wif", "url"), "https://wifly.app/marv");
        // multicall keeps msg.sender: bob can't batch onto alice's name
        vm.prank(bob);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.multicall(calls);
    }

    function test_multicall_claimThenRecords() public {
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(WiflyNames.claim, ("newbie.wif"));
        calls[1] = abi.encodeCall(WiflyNames.setText, (uint256(keccak256("newbie")), "bio", "hi"));
        vm.prank(alice);
        n.multicall(calls);
        assertEq(n.ownerOfName("newbie"), alice);
        assertEq(n.text("newbie.wif", "bio"), "hi");
    }

    // ---------------------------------------------------------------- cleared on transfer
    function test_records_clearedOnTransfer() public {
        uint256 id = _claim(alice, "marv");
        _records(alice, id);
        assertEq(n.recordVersion(id), 0);

        vm.expectEmit(address(n));
        emit RecordsCleared(id, 1);
        vm.prank(alice);
        n.transferFrom(alice, bob, id);

        assertEq(n.recordVersion(id), 1);
        assertEq(n.resolve("marv.wif"), bob, "addr back to new owner");
        assertEq(n.text("marv.wif", "avatar"), "");
        assertEq(n.text("marv.wif", "x"), "");

        // new owner writes fresh records; transferring back does not resurrect alice's old ones
        vm.prank(bob);
        n.setText(id, "x", "bob");
        vm.prank(bob);
        n.safeTransferFrom(bob, alice, id);
        assertEq(n.text("marv", "x"), "");
        assertEq(n.resolve("marv"), alice);
    }

    function test_records_clearedOnMarketplaceSale() public {
        uint256 id = _claim(alice, "marv");
        _records(alice, id);
        vm.prank(alice);
        n.list(id, 500e18);
        vm.prank(bob);
        n.buy(id, 500e18);
        assertEq(n.ownerOf(id), bob);
        assertEq(n.resolve("marv.wif"), bob);
        assertEq(n.text("marv.wif", "avatar"), "");
        assertEq(n.text("marv.wif", "x"), "");
        // buyer had no primary -> gets marv.wif as a verified reverse name
        assertEq(n.reverseName(bob), "marv.wif");
        assertEq(n.reverseName(alice), "");
    }

    // ---------------------------------------------------------------- reverse
    function test_reverseName() public {
        uint256 id = _claim(alice, "marv");
        assertEq(n.nameOf(alice), "marv");
        assertEq(n.reverseName(alice), "marv.wif");

        // pointing the name elsewhere breaks the round trip for alice...
        vm.prank(alice);
        n.setAddr(id, hot);
        assertEq(n.reverseName(alice), "");
        // ...and hot can't claim it as its own reverse either (primary must be owned)
        assertEq(n.reverseName(hot), "");
        vm.prank(alice);
        n.setAddr(id, alice); // explicit self = same as default
        assertEq(n.reverseName(alice), "marv.wif");

        // clearing primary clears reverse
        vm.prank(alice);
        n.setPrimary(0);
        assertEq(n.reverseName(alice), "");
    }

    function test_reverseName_secondName() public {
        _claim(alice, "marv");
        uint256 id2 = _claim(alice, "marvin");
        assertEq(n.reverseName(alice), "marv.wif", "first claim stays primary");
        vm.prank(alice);
        n.setPrimary(id2);
        assertEq(n.reverseName(alice), "marvin.wif");
    }

    // ---------------------------------------------------------------- glyphs
    function test_glyphs_haveDot() public {
        WiflyGlyphs g = Proxies.glyphs(owner);
        assertEq(g.CHARSET(), "abcdefghijklmnopqrstuvwxyz0123456789_@ .");
        assertEq(g.slotOf("."), 39);
        assertEq(g.advance("."), 300);
        assertGt(bytes(g.path(".")).length, 0);
        (uint256 w, uint256[] memory xs) = g.layout("marv.wif");
        assertEq(xs.length, 8);
        assertGt(w, 0);
    }
}
