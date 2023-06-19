// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { HGTCore } from "./HGTCore.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/**
 * @title Hubble Gas Token for HubbleNet
 */

contract HGT is HGTCore, Initializable {
    uint256 public constant SCALING_FACTOR = 1e12;
    uint256 public circulatingSupply;

    uint256[50] private __gap;

    constructor(address _lzEndPoint) HGTCore(_lzEndPoint) {}

    function initialize(address _governance) external initializer {
        _transferOwnership(_governance);
    }

    function _debitFrom(address, uint _amount) internal virtual override returns(uint) {
        circulatingSupply -= _amount;
        _amount = _amount / SCALING_FACTOR;
        require(_amount > 1, "HGT: Insufficient amount"); // so that _amount != 0 in the next line
        _amount -= 1; // round down when withdrawing
        return _amount;
    }

    function _creditTo(address _toAddress, uint _amount) internal virtual override whenNotPaused returns(uint) {
        // check for amount and user
        require(
            _amount != 0 && _toAddress != address(0x0),
            "HGT: Insufficient amount or invalid user"
        );

        // scale amount to 18 decimals
        _amount *= SCALING_FACTOR;

        // transfer amount to user
        payable(_toAddress).transfer(_amount);

        circulatingSupply += _amount;
        return _amount;
    }

    function withdraw(
        uint16 _dstChainId,
        bytes memory _toAddress,
        uint _amount,
        address payable _refundAddress,
        address _zroPaymentAddress,
        bytes memory _adapterParams
    ) external payable whenNotPaused {
        require(msg.value >= _amount, "HGT: Insufficient native token transferred");
        uint nativeFee = msg.value - _amount;
        _send(_msgSender(), _dstChainId, _toAddress, _amount, _refundAddress, _zroPaymentAddress, _adapterParams, nativeFee);
    }
}
