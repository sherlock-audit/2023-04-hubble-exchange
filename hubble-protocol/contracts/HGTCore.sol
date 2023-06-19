// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { NonblockingLzApp, BytesLib } from "@layerzerolabs/solidity-examples/contracts/lzApp/NonblockingLzApp.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { IHGTCore } from "./Interfaces.sol";

abstract contract HGTCore is IHGTCore, NonblockingLzApp, Pausable {
    using BytesLib for bytes;

    uint16 public constant PT_SEND = 1;

    constructor(address _lzEndPoint) NonblockingLzApp(_lzEndPoint) {}

    function _nonblockingLzReceive(uint16 _srcChainId, bytes memory _srcAddress, uint64 _nonce, bytes memory _payload) internal virtual override {
        uint16 packetType;
        assembly {
            packetType := mload(add(_payload, 32))
        }

        if (packetType == PT_SEND) {
            _sendAck(_srcChainId, _srcAddress, _nonce, _payload);
        } else {
            revert("HGTCore: unknown packet type");
        }
    }

    function _sendAck(uint16 _srcChainId, bytes memory, uint64 _nonce, bytes memory _payload) internal {
        (, bytes memory toAddressBytes, uint amount) = abi.decode(_payload, (uint16, bytes, uint));

        address to = toAddressBytes.toAddress(0);

        amount = _creditTo(to, amount);
        emit ReceiveFromChain(_srcChainId, to, amount, _nonce);
    }

    function estimateSendFee(uint16 _dstChainId, bytes calldata _toAddress, uint _amount, bool _useZro, bytes calldata _adapterParams) public view returns (uint nativeFee, uint zroFee) {
        // mock the payload for sendFrom()
        bytes memory payload = abi.encode(PT_SEND, _toAddress, _amount);
        return lzEndpoint.estimateFees(_dstChainId, address(this), payload, _useZro, _adapterParams);
    }

    function _send(
        address _from,
        uint16 _dstChainId,
        bytes memory _toAddress,
        uint _amount,
        address payable _refundAddress, // if the source transaction is cheaper than the amount of value passed, refund the additional amount to this address
        address _zroPaymentAddress, // the address of the ZRO token holder who would pay for the transaction (future param)
        bytes memory _adapterParams,
        uint nativeFee
    ) internal virtual {
        uint amount = _debitFrom(_from, _amount);

        bytes memory lzPayload = abi.encode(PT_SEND, _toAddress, amount);
        _lzSend(_dstChainId, lzPayload, _refundAddress, _zroPaymentAddress, _adapterParams, nativeFee);

        uint64 nonce = lzEndpoint.getOutboundNonce(_dstChainId, address(this));
        emit SendToChain(_dstChainId, _from, _toAddress, amount, nonce);
    }

    function _debitFrom(address _from, uint _amount) internal virtual returns(uint);

    function _creditTo(address _toAddress, uint _amount) internal virtual returns(uint);

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
