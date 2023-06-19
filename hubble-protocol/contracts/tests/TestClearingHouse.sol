// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import "../ClearingHouse.sol";
import "../Interfaces.sol";
import "hardhat/console.sol";

contract TestClearingHouse is ClearingHouse {
    using SafeCast for uint256;
    using SafeCast for int256;

    function openPosition2(uint ammIndex, int baseAssetQuantity, uint quote) external {
        uint price;
        if (quote == 0 || quote == type(uint).max) {
            price = amms[ammIndex].lastPrice();
        } else {
            price = quote * 1e18 / uint(abs(baseAssetQuantity));
        }
        openPosition3(ammIndex, baseAssetQuantity, price);
    }

    function openPosition3(uint ammIndex, int baseAssetQuantity, uint price) public {
        uint salt = _blockTimestamp();
        IOrderBook.Order memory order = IOrderBook.Order(ammIndex, _msgSender(), baseAssetQuantity, price, salt, false);
        _openPosition(order, order.baseAssetQuantity, order.price, IOrderBook.OrderExecutionMode.Taker, true);
    }

    function closePosition(uint ammIndex, uint price) external {
        address trader = _msgSender();
        if (price == 0) {
            price = amms[ammIndex].lastPrice();
        }
        uint salt = _blockTimestamp();
        (int baseAssetQuantity,,,) = amms[ammIndex].positions(trader);
        IOrderBook.Order memory order = IOrderBook.Order(ammIndex,_msgSender(), -baseAssetQuantity, price, salt, true);
        _openPosition(order, order.baseAssetQuantity, order.price, IOrderBook.OrderExecutionMode.Taker, true);
    }

    function liquidate2(address trader) external {
        uint price = amms[0].lastPrice();
        liquidate3(trader, price);
    }

    function liquidate3(address trader, uint price) public {
        uint8 ammIndex = 0; // hardcoded for tests
        (int size,,, uint liquidationThreshold) = amms[ammIndex].positions(trader);
        liquidationThreshold = Math.min(liquidationThreshold, abs(size).toUint256());

        int fillAmount = liquidationThreshold.toInt256();
        if (size < 0) {
            fillAmount = -liquidationThreshold.toInt256();
        }
        updatePositions(trader);
        _liquidateSingleAmm(trader, 0, price, fillAmount);
    }

    function setAMM(uint idx, address amm) external {
        amms[idx] = IAMM(amm);
    }

    function setMarginAccount(address _marginAccount) external {
        marginAccount = IMarginAccount(_marginAccount);
    }

    function setOrderBook(address _orderBook) external {
        defaultOrderBook = IOrderBook(_orderBook);
    }
}
