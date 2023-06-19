// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "./Utils.sol";
import "@layerzerolabs/solidity-examples/contracts/util/BytesLib.sol";
import { IHGTCore } from "../../contracts/Interfaces.sol";

contract HGTTests is Utils, IHGTCore {
    using BytesLib for bytes;
    // inital gas token supply to be minted for hgt contract
    uint public totalSupply = 1e6 ether;
    function setUp() public {
        setupContracts();
        // internal bookkeeping for endpoints (not part of a real deploy, just for this test)
        lzEndpointBase.setDestLzEndpoint(address(hgtRemote), address(lzEndpointOther));
        lzEndpointOther.setDestLzEndpoint(address(hgt), address(lzEndpointBase));

        //------  setTrustedRemote(s) -------------------------------------------------------
        // for each HGT, setTrustedRemote to allow it to receive from the remote HGT contract.
        // Note: This is sometimes referred to as the "wire-up" process.
        vm.startPrank(governance);
        hgt.setTrustedRemote(otherChainId, abi.encodePacked(address(hgtRemote), address(hgt)));
        hgtRemote.setTrustedRemote(baseChainId, abi.encodePacked(address(hgt), address(hgtRemote)));
        vm.stopPrank();

        // fund HGT with gas token
        vm.deal(address(hgt), totalSupply);
        assertEq(address(hgt).balance, totalSupply);
    }

    function testDeposit(uint amount) public {
        vm.assume(amount != 0 && amount <= totalSupply / 1e12);
        assertEq(alice.balance, 0);
        assertEq(bob.balance, 0);
        assertEq(hgt.circulatingSupply(), 0);

        // deposit - alice deposits gas token to bob's account on hubbleNet
        usdc.mint(alice, amount);
        bytes memory toAddress = abi.encodePacked(bob);
        (uint nativeFee, ) = hgtRemote.estimateSendFee(baseChainId, toAddress, amount, false, '');
        vm.deal(alice, nativeFee);

        vm.startPrank(alice);
        usdc.approve(address(hgtRemote), amount);

        vm.expectEmit(true, true, false, true, address(hgt));
        emit ReceiveFromChain(otherChainId, bob, amount * 1e12, 1 /* nonce */);
        vm.expectEmit(true, true, false, true, address(hgtRemote));
        emit SendToChain(baseChainId, alice, toAddress, amount, 1 /* nonce */);

        hgtRemote.deposit{value: nativeFee}(baseChainId, toAddress, amount, payable(alice), address(0), '');
        vm.stopPrank();

        assertEq(alice.balance, 0);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(hgtRemote)), amount);
        // scale amount to 18 decimals
        amount *= 1e12;
        assertEq(bob.balance, amount);
        assertEq(hgt.circulatingSupply(), amount);
    }

    function testCannotDeposit() public {
        // cannot deposit 0 amount
        uint amount = 0;
        bytes memory toAddress = abi.encodePacked(alice);

        vm.startPrank(alice);
        vm.expectRevert("HGTRemote: Insufficient amount");
        hgtRemote.deposit(baseChainId, toAddress, amount, payable(alice), address(0), '');
        vm.stopPrank();
        // cannot deposit if send fee is low
        amount += 1;
        usdc.mint(alice, amount);
        (uint nativeFee, ) = hgtRemote.estimateSendFee(baseChainId, toAddress, amount, false, '');
        vm.deal(alice, nativeFee);

        vm.startPrank(alice);
        usdc.approve(address(hgtRemote), amount);
        vm.expectRevert("LayerZeroMock: not enough native for fees");
        hgtRemote.deposit{value: nativeFee - 1}(baseChainId, toAddress, amount, payable(alice), address(0), '');
        // successful deposit
        hgtRemote.deposit{value: nativeFee}(baseChainId, toAddress, amount, payable(alice), address(0), '');
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(hgtRemote)), amount);
        amount *= 1e12;
        assertEq(alice.balance, amount);
        assertEq(hgt.circulatingSupply(), amount);
    }

    function testWithdraw(uint amount) public {
        vm.assume(amount != 0 && amount <= totalSupply / 1e12);

        // deposit - alice deposits gas token to bob's account on hubbleNet
        uint initialDepositUsdc;
        bytes memory toAddress;
        (toAddress, amount, initialDepositUsdc) = _deposit(alice, bob, amount);

        // withdraw
        // bob transfers 1/3 gas tokens to alice, this is to test round down
        vm.startPrank(bob);
        uint toAlice = amount / 3;
        payable(alice).transfer(toAlice);
        // bob withdraws remaining to their account on C-chain
        amount = amount - toAlice;
        (uint nativeFee, ) = hgt.estimateSendFee(otherChainId, toAddress, amount, false, '');
        // subtract native fee from withdraw amount to pay for layer0 contract
        amount = amount - nativeFee;
        hgt.withdraw{value: amount + nativeFee}(otherChainId, toAddress, amount, payable(bob), address(0), '');
        vm.stopPrank();

        // assertions
        assertEq(alice.balance, toAlice);
        assertEq(bob.balance, 0);
        assertEq(usdc.balanceOf(alice), 0);
        uint bobUsdcBalance = amount / 1e12 - 1;
        assertEq(usdc.balanceOf(bob), bobUsdcBalance);
        assertEq(usdc.balanceOf(address(hgtRemote)), initialDepositUsdc - bobUsdcBalance);
        assertEq(hgt.circulatingSupply(), toAlice + nativeFee);
    }

    function testCannotWithdraw() public {
        uint amount = 100 * 1e6;
        (bytes memory toAddress,,) = _deposit(alice, alice, amount);

        // cannot withdraw if msg.value < amount
        vm.startPrank(alice);
        uint withdrawAmount = 50 ether;
        vm.expectRevert("HGT: Insufficient native token transferred");
        hgt.withdraw{value: withdrawAmount - 1}(otherChainId, toAddress, withdrawAmount, payable(alice), address(0), '');

        // cannot withdraw if withdraw amount is too less
        withdrawAmount = 2e12 - 1;
        vm.expectRevert("HGT: Insufficient amount");
        hgt.withdraw{value: withdrawAmount}(otherChainId, toAddress, withdrawAmount, payable(alice), address(0), '');

        // successful withdraw
        withdrawAmount += 1;
        (uint nativeFee, ) = hgt.estimateSendFee(otherChainId, toAddress, withdrawAmount, false, '');
        hgt.withdraw{value: withdrawAmount + nativeFee}(otherChainId, toAddress, withdrawAmount, payable(alice), address(0), '');
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 1);
    }

    function _deposit(address from, address to, uint amount) internal returns (bytes memory, uint, uint) {
        bytes memory toAddress = abi.encodePacked(to);
        (uint nativeFee, ) = hgtRemote.estimateSendFee(baseChainId, toAddress, amount, false, '');
        vm.deal(from, nativeFee);
        // depositing enough amount so that it doesn't revert while withdrawing due to withdraw amount < nativeFee
        amount += 2 * nativeFee / 1e12;
        if (amount > totalSupply / 1e12) {
            amount = totalSupply / 1e12;
        }

        uint initialDepositUsdc = amount;

        usdc.mint(from, amount);
        vm.startPrank(from);
        usdc.approve(address(hgtRemote), amount);
        hgtRemote.deposit{value: nativeFee}(baseChainId, toAddress, amount, payable(from), address(0), '');
        vm.stopPrank();

        amount *= 1e12;
        assertEq(usdc.balanceOf(from), 0);
        assertEq(to.balance, amount);
        assertEq(hgt.circulatingSupply(), amount);
        return (toAddress, amount, initialDepositUsdc);
    }
}
