// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { VUSD } from "./VUSD.sol";
import { IMarginAccount, IInsuranceFund, IVUSD, IRegistry } from "./Interfaces.sol";
import { HubbleBase } from "./legos/HubbleBase.sol";

/**
 * @title Helper contract for (un)wrapping tokens (vusd) before/after deposting/withdrawing from margin account/insurance fund
 * @notice USDC is both the gas token and the token backing vusd; which is the currency used in the margin account and insurance fund;
 * Therefore, this contract serves as a helper to (unwrap) usdc (gas token)
*/
contract MarginAccountHelper is HubbleBase {
    using SafeERC20 for IERC20;

    uint constant VUSD_IDX = 0;

    IMarginAccount public marginAccount;
    IVUSD public vusd;
    IInsuranceFund public insuranceFund;

    uint256[50] private __gap;

    function initialize(
        address _governance,
        address _vusd,
        address _marginAccount,
        address _insuranceFund
    ) external initializer {
        _setGovernace(_governance);
        vusd = IVUSD(_vusd);
        marginAccount = IMarginAccount(_marginAccount);
        insuranceFund = IInsuranceFund(_insuranceFund);
        IERC20(_vusd).safeApprove(_marginAccount, type(uint).max);
        IERC20(_vusd).safeApprove(_insuranceFund, type(uint).max);
    }

    /**
     * @notice Accepts gas token (usdc), wraps it for vusd and deposits it to margin account for the trader
     * @param amount Amount of vusd to deposit. msg.value has to be exactly 1e12 times `amount`
    */
    function addVUSDMarginWithReserve(uint256 amount) external payable {
        vusd.mintWithReserve{value: msg.value}(address(this), amount);
        marginAccount.addMarginFor(VUSD_IDX, amount, msg.sender);
    }

    /**
     * @notice Remove margin on trader's behalf, enter the withdrawal Q and process the withdrawals
    */
    function removeMarginInUSD(uint256 amount) external {
        address trader = msg.sender;
        marginAccount.removeMarginFor(VUSD_IDX, amount, trader);
        vusd.withdrawTo(trader, amount);
        vusd.processWithdrawals();
    }

    /**
    * @notice Deposit vusd to insurance fund using gas token (usdc)
    */
    function depositToInsuranceFund(uint256 amount) external payable {
        vusd.mintWithReserve{value: msg.value}(address(this), amount);
        insuranceFund.depositFor(msg.sender, amount);
    }

    /**
    * @notice Withdraw vusd from insurance fund and get gas token (usdc)
    */
    function withdrawFromInsuranceFund(uint256 shares) external {
        address user = msg.sender;
        uint amount = insuranceFund.withdrawFor(user, shares);
        vusd.withdrawTo(user, amount);
        vusd.processWithdrawals();
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function syncDeps(address _registry) public onlyGovernance {
        IRegistry registry = IRegistry(_registry);
        vusd = IVUSD(registry.vusd());
        marginAccount = IMarginAccount(registry.marginAccount());
        insuranceFund = IInsuranceFund(registry.insuranceFund());
    }
}
