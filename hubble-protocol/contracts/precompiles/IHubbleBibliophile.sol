// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;
// pragma solidity 0.8.4;

import { IOrderBook } from "../Interfaces.sol";

interface IHubbleBibliophile {
    function getNotionalPositionAndMargin(address trader, bool includeFundingPayments, uint8 mode)
        external
        view
        returns(uint256 notionalPosition, int256 margin);

    function getPositionSizes(address trader) external view returns(int[] memory posSizes);

    function validateOrdersAndDetermineFillPrice(
        IOrderBook.Order[2] memory orders,
        bytes32[2] memory orderHashes,
        int256 fillAmount
    ) external view returns(uint256 fillPrice, IOrderBook.OrderExecutionMode mode0, IOrderBook.OrderExecutionMode mode1);

    function validateLiquidationOrderAndDetermineFillPrice(
        IOrderBook.Order memory order,
        int256 fillAmount
    ) external view returns(uint256 fillPrice);
}
