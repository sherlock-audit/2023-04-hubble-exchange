// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "../AMM.sol";

contract TestAmm is AMM {
    using SafeCast for uint256;

    constructor(address _clearingHouse) AMM(_clearingHouse) {}

    function getOracleBasedMarginFraction(address trader, int256 margin)
        external
        view
        returns (uint oracleBasedNotional, int256 oracleBasedUnrealizedPnl, int256 marginFraction)
    {
        return getPositionMetadata(getUnderlyingPrice(), positions[trader].openNotional, positions[trader].size, margin);
    }
}
