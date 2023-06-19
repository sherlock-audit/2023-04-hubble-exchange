// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "./Utils.sol";

contract VUSDWithoutReceiveTest is Utils {
    event WithdrawalFailed(address indexed trader, uint amount, bytes data);

    function setUp() public {
        setupContracts();
    }

    function testWithdrawRevert(uint128 amount) public {
        vm.assume(amount >= 5e6);
        // mint vusd for this contract
        mintVusd(address(this), amount);
        // alice and bob also mint vusd
        mintVusd(alice, amount);
        mintVusd(bob, amount);

        // withdraw husd
        husd.withdraw(amount); // first withdraw in the array
        vm.prank(alice);
        husd.withdraw(amount);
        vm.prank(bob);
        husd.withdraw(amount);

        assertEq(husd.withdrawalQLength(), 3);
        assertEq(husd.start(), 0);

        uint scaledAmount = uint(amount) * 1e12;
        vm.expectEmit(true, false, false, true, address(husd));
        emit WithdrawalFailed(address(this), scaledAmount, '');
        husd.processWithdrawals();

        assertEq(husd.withdrawalQLength(), 3);
        assertEq(husd.start(), 3);
        assertEq(alice.balance, scaledAmount);
        assertEq(bob.balance, scaledAmount);
    }
}
