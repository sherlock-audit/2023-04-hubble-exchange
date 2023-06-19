// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { ERC2771Context } from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { Context } from "@openzeppelin/contracts/utils/Context.sol";

import { Governable } from "./Governable.sol";

contract HubbleBase is Governable, Pausable {
    function _blockTimestamp() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function pause() external onlyGovernance {
        _pause();
    }

    function unpause() external onlyGovernance {
        _unpause();
    }
}

contract MetaHubbleBase is HubbleBase, ERC2771Context {
    /**
    * @dev _trustedForwarder is a private immutable var in ERC2771Context
    */
    constructor(address _trustedForwarder) ERC2771Context(_trustedForwarder) {}

    /* ****************** */
    /*   Internal View    */
    /* ****************** */

    function _msgSender()
        internal
        view
        override(Context, ERC2771Context)
        returns (address)
    {
        return super._msgSender();
    }

    function _msgData()
        internal
        view
        override(Context, ERC2771Context)
        returns (bytes memory)
    {
        return super._msgData();
    }
}

