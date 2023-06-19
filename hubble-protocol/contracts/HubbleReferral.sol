// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { Governable } from "./legos/Governable.sol";

contract HubbleReferral is Governable {

    struct ReferralInfo {
        uint createdAt;
        string referralCode;
    }

    event ReferralCodeCreated(address indexed referrer, string referralCode, uint timestamp);
    // will be used to calculate total used referrals for a referrer
    event ReferrerAdded(address indexed trader, address referrer, uint timestamp);

    mapping(address => ReferralInfo) public referrers;
    mapping(address => ReferralInfo) public traders;
    mapping(string => address) public referralCodeToReferrerMap;

    function initialize() external initializer {
    }

    function createReferralCode(string calldata referralCode) external {
        _createReferralCode(referralCode, msg.sender);
    }

    function setReferralCode(string calldata referralCode) external {
        _setReferralCode(referralCode, msg.sender);
    }

    function _createReferralCode(string calldata _referralCode, address _referrer) internal {
        require(bytes(_referralCode).length >= 4, "HR: referral code too short");

        address existingReferrer = referralCodeToReferrerMap[_referralCode];
        require(existingReferrer == address(0x0), "HR: referral code already exists");

        require(bytes(referrers[_referrer].referralCode).length == 0,
            "HR: referral code already exists for this address");

        referrers[_referrer] = ReferralInfo(block.timestamp, _referralCode);
        referralCodeToReferrerMap[_referralCode] = _referrer;
        emit ReferralCodeCreated(_referrer, _referralCode, block.timestamp);
    }

    function _setReferralCode(string calldata _referralCode, address _trader) internal {
        require(bytes(_referralCode).length >= 4, "HR: referral code too short");
        require(bytes(traders[_trader].referralCode).length == 0, 'HR: referrer already added');

        address _referrer = referralCodeToReferrerMap[_referralCode];
        require(_referrer != address(0x0), "HR: referral code does not exist");
        require(_trader != _referrer, 'HR: cannot be a referee of a referral code you own');

        traders[_trader] = ReferralInfo(block.timestamp, _referralCode);
        emit ReferrerAdded(_trader, _referrer, block.timestamp);
    }

    function getReferralCodeByAddress(address _referrer) external view
        returns (string memory)
    {
        return referrers[_referrer].referralCode;
    }

    function getTraderRefereeInfo(address _trader) external view
        returns (address referrer)
    {
        string memory referralCode = traders[_trader].referralCode;
        referrer = referralCodeToReferrerMap[referralCode];
    }
}
