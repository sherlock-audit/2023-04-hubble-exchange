// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "./Interfaces.sol";
import { HGTCore } from "./HGTCore.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/**
 * @title Hubble Gas Token for Remote Chains
 */

contract HGTRemote is HGTCore, Initializable  {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    uint256[50] private __gap;

    constructor(address _lzEndPoint, address _usdc) HGTCore(_lzEndPoint) {
        usdc = IERC20(_usdc);
    }

    function initialize(address _governance) external initializer {
        _transferOwnership(_governance);
    }

    function _debitFrom(address _from, uint _amount) internal virtual override returns(uint) {
        // check for amount and user
        require(_amount != 0, "HGTRemote: Insufficient amount");
        usdc.safeTransferFrom(_from, address(this), _amount);
        return _amount;
    }

    function _creditTo(address _toAddress, uint _amount) internal virtual override whenNotPaused returns(uint) {
        // check for amount and user
        require(
            _amount != 0 && _toAddress != address(0x0),
            "HGTRemote: Insufficient amount or invalid user"
        );

        // transfer amount to user
        usdc.safeTransfer(_toAddress, _amount);
        return _amount;

    }

    function deposit(
        uint16 _dstChainId,
        bytes memory _toAddress,
        uint _amount,
        address payable _refundAddress,
        address _zroPaymentAddress,
        bytes memory _adapterParams
    ) external payable whenNotPaused {
        _send(_msgSender(), _dstChainId, _toAddress, _amount, _refundAddress, _zroPaymentAddress, _adapterParams, msg.value);
    }
}
