// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WiflyNames} from "../src/WiflyNames.sol";
import {Wifly} from "../src/Wifly.sol";
import {MockWIF, MockNoBurn} from "./mocks/MockWIF.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Proxies} from "./utils/Proxies.sol";

contract WiflyNamesTest is Test {
    WiflyNames internal n;
    MockWIF internal token;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant FEE = 100e18;
    uint256 internal constant SHORT_FEE = 1_000e18;

    function setUp() public {
        token = new MockWIF();
        n = Proxies.names(address(token), true, owner, treasury, FEE, SHORT_FEE);
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            token.mint(users[i], 1_000_000e18);
            vm.prank(users[i]);
            token.approve(address(n), type(uint256).max);
        }
    }

    function _claim(address who, string memory name) internal returns (uint256 id) {
        vm.prank(who);
        id = n.claim(name);
    }

    // ---------------------------------------------------------------- validation
    function test_isValidName() public view {
        assertTrue(n.isValidName("abc"));
        assertTrue(n.isValidName("marv_01"));
        assertTrue(n.isValidName("abcdefghijklmnopqrst")); // 20
        assertFalse(n.isValidName("ab"));
        assertFalse(n.isValidName("abcdefghijklmnopqrstu")); // 21
        assertFalse(n.isValidName("Marv"));
        assertFalse(n.isValidName("marv.eth"));
        assertFalse(n.isValidName("ma rv"));
        assertFalse(n.isValidName("marv-x"));
        assertFalse(n.isValidName(unicode"mårv"));
        assertFalse(n.isValidName(""));
    }

    function testFuzz_isValidName_matchesReference(bytes memory b) public view {
        bool ok = b.length >= 3 && b.length <= 20;
        for (uint256 i; ok && i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 95;
        }
        assertEq(n.isValidName(string(b)), ok);
    }

    // ---------------------------------------------------------------- claim
    function test_claim_splitsFeeAndSetsPrimary() public {
        uint256 supply = token.totalSupply();
        uint256 id = _claim(alice, "alice");
        assertEq(n.ownerOf(id), alice);
        assertEq(n.ownerOfName("alice"), alice);
        assertEq(n.nameOf(alice), "alice");
        assertEq(n.nameOfToken(id), "alice");
        assertEq(n.primaryOf(alice), id);
        // no pot set yet -> claims burn nothing, the 50% pot share goes to the treasury too
        assertEq(token.totalSupply(), supply);
        assertEq(n.totalBurned(), 0);
        assertEq(token.balanceOf(treasury), FEE);
        assertEq(token.balanceOf(address(n)), 0);
        assertFalse(n.isAvailable("alice"));
    }

    function test_claim_shortNameCostsMore() public {
        uint256 bal = token.balanceOf(alice);
        _claim(alice, "abcd");
        assertEq(bal - token.balanceOf(alice), SHORT_FEE);
        _claim(alice, "abcde");
        assertEq(bal - token.balanceOf(alice), SHORT_FEE + FEE);
        assertEq(n.nameOf(alice), "abcd", "first claim stays primary");
    }

    function test_claim_reverts() public {
        _claim(alice, "taken");
        vm.expectRevert(WiflyNames.NameTaken.selector);
        _claim(bob, "taken");
        vm.expectRevert(WiflyNames.InvalidName.selector);
        _claim(bob, "Taken");
        vm.prank(owner);
        n.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _claim(bob, "other");
    }

    function test_claim_freeWhenFeeZero() public {
        vm.prank(owner);
        n.setClaimFees(0, 0);
        address dave = makeAddr("dave"); // no WIF, no approval
        uint256 id = _claim(dave, "dave");
        assertEq(n.ownerOf(id), dave);
    }

    function test_claim_noBurnTokenSendsToDead() public {
        MockNoBurn nb = new MockNoBurn();
        WiflyNames n2 = Proxies.names(address(nb), false, owner, treasury, FEE, SHORT_FEE);
        nb.mint(alice, 1_000e18);
        vm.startPrank(alice);
        nb.approve(address(n2), type(uint256).max);
        n2.claim("alice");
        vm.stopPrank();
        assertEq(nb.balanceOf(n2.DEAD()), 0); // claims never burn
        assertEq(nb.balanceOf(treasury), FEE);
        // sale fee burns 10% to the dead address
        uint256 id = n2.idOf("alice");
        vm.prank(alice);
        n2.list(id, 1_000e18);
        nb.mint(bob, 1_000e18);
        vm.startPrank(bob);
        nb.approve(address(n2), type(uint256).max);
        n2.buy(id, 1_000e18);
        vm.stopPrank();
        assertEq(nb.balanceOf(n2.DEAD()), 2.5e18);
        assertEq(nb.balanceOf(treasury), FEE + 22.5e18);
    }

    function test_reserve_andLock() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        n.reserve("wifly", alice);
        vm.prank(owner);
        uint256 id = n.reserve("wifly", treasury);
        assertEq(n.ownerOf(id), treasury);
        vm.prank(owner);
        n.lockReservations();
        vm.prank(owner);
        vm.expectRevert(WiflyNames.Locked.selector);
        n.reserve("support", treasury);
    }

    // ---------------------------------------------------------------- primary
    function test_setPrimary() public {
        uint256 a = _claim(alice, "aaa");
        uint256 b = _claim(alice, "bbb");
        vm.prank(alice);
        n.setPrimary(b);
        assertEq(n.nameOf(alice), "bbb");
        vm.prank(bob);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.setPrimary(a);
        vm.prank(alice);
        n.setPrimary(0);
        assertEq(n.nameOf(alice), "");
    }

    function test_transfer_clearsSenderPrimary_doesNotPushOnReceiver() public {
        uint256 id = _claim(alice, "gift");
        vm.prank(alice);
        n.transferFrom(alice, bob, id);
        assertEq(n.nameOf(alice), "");
        assertEq(n.nameOf(bob), "", "plain transfer never sets the receiver's primary");
        assertEq(n.ownerOfName("gift"), bob);
    }

    // ---------------------------------------------------------------- marketplace
    function test_list_buy_feesAndPrimary() public {
        uint256 id = _claim(alice, "rare");
        vm.prank(alice);
        n.list(id, 1_000e18);
        uint256 supply = token.totalSupply();
        uint256 aliceBal = token.balanceOf(alice);
        uint256 bobBal = token.balanceOf(bob);

        vm.expectEmit(address(n));
        emit WiflyNames.Sold(id, alice, bob, 1_000e18, 25e18);
        vm.expectEmit(address(n));
        emit WiflyNames.FeeSplit(0, 22.5e18, 2.5e18); // pot unset: the 22.5e18 pot share goes to the treasury
        vm.prank(bob);
        n.buy(id, 1_000e18);

        assertEq(n.ownerOf(id), bob);
        assertEq(n.nameOf(bob), "rare");
        assertEq(n.nameOf(alice), "");
        assertEq(bobBal - token.balanceOf(bob), 1_000e18);
        assertEq(token.balanceOf(alice) - aliceBal, 975e18);
        assertEq(supply - token.totalSupply(), 2.5e18); // 10% of the 2.5% fee
        assertEq(token.balanceOf(treasury), 1_000e18 + 22.5e18); // short claim fee (100%) + 90% of sale fee (pot unset)
        assertEq(token.balanceOf(address(n)), 0);
        (address seller,) = n.listings(id);
        assertEq(seller, address(0));
    }

    function test_buy_keepsExistingPrimary() public {
        _claim(bob, "bobby");
        uint256 id = _claim(alice, "rare");
        vm.prank(alice);
        n.list(id, 10e18);
        vm.prank(bob);
        n.buy(id, 10e18);
        assertEq(n.nameOf(bob), "bobby");
    }

    function test_buy_reverts() public {
        uint256 id = _claim(alice, "rare");
        vm.prank(bob);
        vm.expectRevert(WiflyNames.NotListed.selector);
        n.buy(id, 1e18);
        vm.prank(alice);
        n.list(id, 10e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(WiflyNames.PriceChanged.selector, 10e18));
        n.buy(id, 9e18);
        vm.prank(alice);
        vm.expectRevert(WiflyNames.SelfBuy.selector);
        n.buy(id, 10e18);
    }

    function test_list_reverts_and_cancel() public {
        uint256 id = _claim(alice, "rare");
        vm.prank(bob);
        vm.expectRevert(WiflyNames.NotNameOwner.selector);
        n.list(id, 1e18);
        vm.prank(alice);
        vm.expectRevert(WiflyNames.ZeroAmount.selector);
        n.list(id, 0);
        vm.prank(alice);
        n.list(id, 5e18);
        vm.prank(bob);
        vm.expectRevert(WiflyNames.NotListed.selector);
        n.cancel(id);
        vm.prank(alice);
        n.cancel(id);
        vm.prank(bob);
        vm.expectRevert(WiflyNames.NotListed.selector);
        n.buy(id, 5e18);
    }

    function test_transfer_clearsListing_evenViaApprovedOperator() public {
        uint256 id = _claim(alice, "rare");
        vm.startPrank(alice);
        n.list(id, 5e18);
        n.approve(carol, id);
        vm.stopPrank();
        vm.prank(carol);
        n.safeTransferFrom(alice, carol, id);
        (address seller,) = n.listings(id);
        assertEq(seller, address(0));
        // the old owner's listing can't be bought, and carol giving it back doesn't revive it
        vm.prank(carol);
        n.transferFrom(carol, alice, id);
        vm.prank(bob);
        vm.expectRevert(WiflyNames.NotListed.selector);
        n.buy(id, 5e18);
    }

    function test_owner_setters() public {
        vm.startPrank(owner);
        vm.expectRevert(WiflyNames.FeeTooHigh.selector);
        n.setFeeBps(1_001);
        n.setFeeBps(1_000);
        vm.expectRevert(WiflyNames.ZeroAddress.selector);
        n.setTreasury(address(0));
        n.setTreasury(carol);
        vm.stopPrank();
        assertEq(n.feeBps(), 1_000);
        assertEq(n.treasury(), carol);
    }

    function test_tokenURI() public {
        uint256 id = _claim(alice, "marv");
        string memory uri = n.tokenURI(id);
        assertEq(bytes(uri).length > 29, true);
        assertEq(
            uri,
            string.concat(
                "data:application/json;base64,",
                vm.toBase64(bytes('{"name":"marv.wif","description":"marv.wif, a WIF Name on Robinhood Chain."}'))
            )
        );
    }

    function testFuzz_sale_conservesWif(uint256 price, uint16 feeBps) public {
        price = bound(price, 1, 100_000e18);
        feeBps = uint16(bound(feeBps, 0, 1_000));
        vm.prank(owner);
        n.setFeeBps(feeBps);
        uint256 id = _claim(alice, "fuzzy");
        vm.prank(alice);
        n.list(id, price);
        uint256 before = token.balanceOf(alice) + token.balanceOf(bob) + token.balanceOf(treasury);
        uint256 supply = token.totalSupply();
        vm.prank(bob);
        n.buy(id, price);
        uint256 afterSum = token.balanceOf(alice) + token.balanceOf(bob) + token.balanceOf(treasury);
        assertEq(before - afterSum, supply - token.totalSupply(), "only the burn leaves");
        assertEq(token.balanceOf(address(n)), 0);
    }

    // ---------------------------------------------------------------- splits with the Wifly pot
    function _withPot() internal returns (Wifly w) {
        w = Proxies.wifly(address(token), true, owner, makeAddr("attester"), makeAddr("wiflyTreasury"), 100e18);
        vm.expectEmit(address(n));
        emit WiflyNames.PotSet(address(w));
        vm.prank(owner);
        n.setPot(address(w));
    }

    function test_claim_splits_50_50_withPot() public {
        Wifly w = _withPot();
        uint256 supply = token.totalSupply();
        vm.expectEmit(address(n));
        emit WiflyNames.FeeSplit(50e18, 50e18, 0);
        _claim(alice, "alice");
        assertEq(token.balanceOf(treasury), 50e18);
        assertEq(w.epochPot(), 50e18);
        assertEq(token.balanceOf(address(w)), 50e18);
        assertEq(supply - token.totalSupply(), 0);
        assertEq(n.totalBurned(), 0);
        assertEq(token.balanceOf(address(n)), 0);
        assertEq(token.allowance(address(n), address(w)), 0, "no dangling approval");
        assertEq(w.totalLiabilities(), token.balanceOf(address(w)), "pot is fully backed");
    }

    function test_shortClaim_splits_50_50_withPot() public {
        Wifly w = _withPot();
        _claim(alice, "abc");
        assertEq(token.balanceOf(treasury), 500e18);
        assertEq(w.epochPot(), 500e18);
    }

    function test_sale_splits_90_10_withPot() public {
        uint256 id = _claim(alice, "rare");
        Wifly w = _withPot();
        vm.prank(alice);
        n.list(id, 1_000e18);
        uint256 tBefore = token.balanceOf(treasury);
        uint256 supply = token.totalSupply();
        vm.expectEmit(address(n));
        emit WiflyNames.FeeSplit(0, 22.5e18, 2.5e18);
        vm.prank(bob);
        n.buy(id, 1_000e18);
        assertEq(token.balanceOf(treasury) - tBefore, 0);
        assertEq(w.epochPot(), 22.5e18);
        assertEq(supply - token.totalSupply(), 2.5e18);
    }

    function test_split_roundingDustToPot() public {
        Wifly w = _withPot();
        vm.prank(owner);
        n.setClaimFees(19, 19); // 19 wei: treasury floor(9.5)=9, pot 10, no burn
        uint256 supply = token.totalSupply();
        _claim(alice, "dusty");
        assertEq(token.balanceOf(treasury), 9);
        assertEq(w.epochPot(), 10);
        assertEq(supply - token.totalSupply(), 0);
        (uint256 t, uint256 p) = n.quoteClaimSplit(19);
        assertEq(t, 9);
        assertEq(p, 10);
        (uint256 sp, uint256 sb) = n.quoteSplit(19); // sale fee: burn floor(1.9)=1, pot 18
        assertEq(sp, 18);
        assertEq(sb, 1);
        assertEq(n.CLAIM_TREASURY_BPS() + n.CLAIM_POT_BPS(), 10_000);
        assertEq(n.SALE_POT_BPS() + n.SALE_BURN_BPS(), 10_000);
        assertEq(n.CLAIM_TREASURY_BPS(), 5_000);
        assertEq(n.SALE_POT_BPS(), 9_000);
        assertEq(n.SALE_BURN_BPS(), 1_000);
    }

    function test_quoteSale() public {
        uint256 id = _claim(alice, "rare");
        vm.prank(alice);
        n.list(id, 1_000e18);
        (uint256 fee, uint256 p, uint256 b, uint256 net) = n.quoteSale(1_000e18);
        assertEq(fee, 25e18);
        assertEq(p, 22.5e18);
        assertEq(b, 2.5e18);
        assertEq(net, 975e18);
    }

    function test_setPot_onlyOwner_andUnset() public {
        Wifly w = _withPot();
        assertEq(address(n.pot()), address(w));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        n.setPot(alice);
        vm.prank(owner);
        n.setPot(address(0)); // back to "pot share goes to treasury"
        _claim(alice, "alice");
        assertEq(w.epochPot(), 0);
        assertEq(token.balanceOf(treasury), 100e18);
    }

    function test_claim_worksWhileWiflyPaused() public {
        Wifly w = _withPot();
        vm.prank(owner);
        w.pause();
        _claim(alice, "alice");
        assertEq(w.epochPot(), 50e18);
    }

    function testFuzz_claimSplit(uint256 fee) public {
        fee = bound(fee, 0, 1_000_000e18);
        Wifly w = _withPot();
        vm.prank(owner);
        n.setClaimFees(fee, fee);
        uint256 supply = token.totalSupply();
        _claim(alice, "fuzzy");
        uint256 burned = supply - token.totalSupply();
        assertEq(burned, 0);
        assertEq(token.balanceOf(treasury), fee * 5_000 / 10_000);
        assertEq(w.epochPot(), fee - fee * 5_000 / 10_000);
        assertEq(token.balanceOf(treasury) + w.epochPot() + burned, fee);
    }
}
