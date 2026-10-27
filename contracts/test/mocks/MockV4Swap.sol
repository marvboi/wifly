// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockWIF} from "./MockWIF.sol";
import {PoolKey, ExactInputSingleParams, QuoteExactSingleParams} from "../../src/interfaces/IUniswapV4Minimal.sol";

/// @dev Universal Router stand-in. Decodes the exact V4_SWAP payload WiflyDCA builds (and checks every field),
///      then mints WIF to the TAKE recipient at `rate` WIF-wei per 1 ETH, minus a 1% "hook" cut like the real pool.
///      Keeps the ETH (as if it went to the PoolManager).
contract MockUniversalRouter {
    MockWIF public immutable wif;
    address public immutable hooks;
    uint256 public rate; // WIF wei per 1e18 ETH wei, before the 1% cut
    bool public shortChange; // pay less than amountOutMinimum without reverting (a broken router)
    bool public broken; // always revert
    address public reenterTarget; // if set, try to reenter during execute
    bytes public reenterData;
    uint256 public swaps;
    address public lastRecipient;

    error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived);

    constructor(MockWIF wif_, address hooks_, uint256 rate_) {
        wif = wif_;
        hooks = hooks_;
        rate = rate_;
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    function setShortChange(bool v) external {
        shortChange = v;
    }

    function setBroken(bool v) external {
        broken = v;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function out(uint256 amountIn) public view returns (uint256) {
        return amountIn * rate / 1e18 * 99 / 100;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(!broken, "broken");
        require(deadline >= block.timestamp, "deadline");
        require(commands.length == 1 && uint8(commands[0]) == 0x10, "V4_SWAP");
        require(inputs.length == 1, "inputs");
        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        require(keccak256(actions) == keccak256(hex"060c0e"), "actions");
        require(params.length == 3, "params");
        ExactInputSingleParams memory p = abi.decode(params[0], (ExactInputSingleParams));
        require(p.zeroForOne, "zeroForOne");
        require(p.poolKey.currency0 == address(0) && p.poolKey.currency1 == address(wif), "currencies");
        require(p.poolKey.fee == 0 && p.poolKey.tickSpacing == 200 && p.poolKey.hooks == hooks, "key");
        require(p.hookData.length == 0, "hookData");
        require(msg.value == p.amountIn, "value");
        (address settleCur, uint256 settleAmt) = abi.decode(params[1], (address, uint256));
        require(settleCur == address(0) && settleAmt == p.amountIn, "settle");
        (address takeCur, address recipient, uint256 takeAmt) = abi.decode(params[2], (address, address, uint256));
        require(takeCur == address(wif) && takeAmt == 0, "take");

        if (reenterTarget != address(0)) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }

        uint256 o = out(p.amountIn);
        if (shortChange) {
            o = p.amountOutMinimum / 2;
        } else if (o < p.amountOutMinimum) {
            revert V4TooLittleReceived(p.amountOutMinimum, o);
        }
        swaps++;
        lastRecipient = recipient;
        wif.mint(recipient, o);
    }
}

/// @dev V4Quoter stand-in: quotes the router's rate unless overridden.
contract MockV4Quoter {
    MockUniversalRouter public immutable router;
    uint256 public override_; // if non-zero, returned as the quote
    bool public broken;

    constructor(MockUniversalRouter r) {
        router = r;
    }

    function setOverride(uint256 q) external {
        override_ = q;
    }

    function setBroken(bool v) external {
        broken = v;
    }

    function quoteExactInputSingle(QuoteExactSingleParams memory p)
        external
        view
        returns (uint256 amountOut, uint256 gasEstimate)
    {
        require(!broken, "quoter broken");
        require(p.zeroForOne && p.poolKey.currency1 == address(router.wif()), "quote params");
        amountOut = override_ != 0 ? override_ : router.out(p.exactAmount);
        gasEstimate = 100_000;
    }
}
