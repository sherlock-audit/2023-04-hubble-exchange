// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

contract VanillaGovernable {
    address private _governance;

    modifier onlyGovernance() {
        require(msg.sender == _governance, "ONLY_GOVERNANCE");
        _;
    }

    function governance() public view returns (address) {
        return _governance;
    }

    function setGovernace(address __governance) external onlyGovernance {
        _setGovernace(__governance);
    }

    function _setGovernace(address __governance) internal {
        _governance = __governance;
    }
}

contract Governable is VanillaGovernable, Initializable {}
