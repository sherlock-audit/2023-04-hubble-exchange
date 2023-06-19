// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { Oracle } from "../Oracle.sol";

contract TestOracle is Oracle {

    mapping(address => int256) prices; // SLOT_3
    mapping(address => int256) twapPrices;
    mapping(address => bool) public isUpdater;

    event MockUnderlyingPriceUpdated(address underlying, int256 price);
    event MockUnderlyingTwapPriceUpdated(address underlying, int256 price);

    function getUnderlyingPrice(address underlying)
        override
        external
        view
        returns(int256 answer)
    {
        if (stablePrice[underlying] != 0) {
            return stablePrice[underlying];
        }
        require(prices[underlying] != 0, "underlying price has not been set as yet");
        return prices[underlying];
    }

    function getUnderlyingTwapPrice(address underlying, uint256 /* intervalInSeconds */)
        override
        public
        view
        returns (int256)
    {
        if (stablePrice[underlying] != 0) {
            return stablePrice[underlying];
        }
        require(twapPrices[underlying] != 0, "underlying twap price has not been set as yet");
        return twapPrices[underlying];
    }

    function setUnderlyingPrice(address underlying, int256 _price) external {
        require(msg.sender == governance() || isUpdater[msg.sender], "not_updater");
        prices[underlying] = _price;
        emit MockUnderlyingPriceUpdated(underlying, _price);
    }

    function setUnderlyingTwapPrice(address underlying, int256 _price) external {
        require(msg.sender == governance() || isUpdater[msg.sender], "not_updater");
        twapPrices[underlying] = _price;
        emit MockUnderlyingTwapPriceUpdated(underlying, _price);
    }

    function setUpdater(address updater, bool enabled) external onlyGovernance {
        isUpdater[updater] = enabled;
    }
}
