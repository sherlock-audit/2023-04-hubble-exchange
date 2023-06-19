// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

contract Registry {
    address public immutable oracle;
    address public immutable clearingHouse;
    address public immutable insuranceFund;
    address public immutable marginAccount;
    address public immutable vusd;
    address public immutable orderBook;
    address public immutable marginAccountHelper;

    constructor(
        address _oracle,
        address _clearingHouse,
        address _insuranceFund,
        address _marginAccount,
        address _vusd,
        address _orderBook,
        address _marginAccountHelper
    ) {
        oracle = _oracle;
        clearingHouse = _clearingHouse;
        insuranceFund = _insuranceFund;
        marginAccount = _marginAccount;
        vusd = _vusd;
        orderBook = _orderBook;
        marginAccountHelper = _marginAccountHelper;
    }
}
