// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

contract BlackList is Ownable {
    mapping(address => bool) public isBlocked;

    function setIsBlocked(address[] calldata user, bool status) external onlyOwner {
        for (uint i; i < user.length; i++) {
            isBlocked[user[i]] = status;
        }
    }
}

