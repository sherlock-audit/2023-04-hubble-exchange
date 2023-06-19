// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import { VanillaGovernable } from "./legos/Governable.sol";
import { IRegistry, IOracle, IMarginAccount, ERC20Detailed, IInsuranceFund } from "./Interfaces.sol";

/**
 * @title The Insurance Fund acts as a backstop for the protocol. Since you can take leverage on Hubble, there is a chance that the protocol will be undercollateralized in the event of a rapid market movement. The insurance fund is used to cover any shortfalls.
*/
contract InsuranceFund is VanillaGovernable, ERC20Upgradeable, IInsuranceFund {
    using SafeERC20 for IERC20;

    uint8 constant DECIMALS = 6;
    uint constant PRECISION = 10 ** DECIMALS;

    IERC20 public vusd;
    address public marginAccount;
    address public marginAccountHelper;
    IOracle public oracle;
    uint public pendingObligation;
    uint public startPriceMultiplier;
    uint public auctionDuration;

    struct UnbondInfo {
        uint shares;
        uint unbondTime;
    }

    struct Auction {
        uint startPrice;
        uint startedAt;
        uint expiryTime;
    }

    /// @notice token to auction mapping
    mapping(address => Auction) public auctions;

    mapping(address => UnbondInfo) public unbond;
    uint256 public withdrawPeriod;
    uint256 public unbondPeriod;
    uint256 public unbondRoundOff;

    uint256[50] private __gap;

    event FundsAdded(address indexed insurer, uint amount, uint timestamp);
    event Unbonded(address indexed trader, uint256 unbondAmount, uint256 unbondTime, uint timestamp);
    event FundsWithdrawn(address indexed insurer, uint amount, uint timestamp);
    event BadDebtAccumulated(uint amount, uint timestamp);

    modifier onlyMarginAccount() {
        require(_msgSender() == address(marginAccount), "IF.only_margin_account");
        _;
    }

    modifier onlyMarginAccountHelper() {
        require(_msgSender() == marginAccountHelper, "IF.only_margin_account_helper");
        _;
    }

    function initialize(address _governance) external initializer {
        __ERC20_init("Hubble-Insurance-Fund", "HIF");
        _setGovernace(_governance);

        unbondPeriod = 2 days;
        withdrawPeriod = 1 days;
        unbondRoundOff = 1 days;
        startPriceMultiplier = 1050000; // 1.05
        auctionDuration = 2 hours;
    }

    /**
     * @notice deposit vusd to the insurance fund
     * @param amount amount to deposit
    */
    function deposit(uint amount) external {
        depositFor(_msgSender(), amount);
    }

    /**
     * @notice Deposit to the insurance fund on behalf of another address
     * @param to address to deposit for
    */
    function depositFor(address to, uint amount) override public {
        settlePendingObligation();
        // we want to protect new LPs, when the insurance fund is in deficit
        require(pendingObligation == 0, "IF.deposit.pending_obligations");

        uint _pool = _totalPoolValue();
        uint _totalSupply = totalSupply();
        uint vusdBalance = balance();
        if (_totalSupply == 0 && vusdBalance > 0) { // trading fee accumulated while there were no IF LPs
            vusd.safeTransfer(governance(), vusdBalance);
            _pool = 0;
        }

        vusd.safeTransferFrom(_msgSender(), address(this), amount);
        uint shares = 0;
        if (_pool == 0) {
            shares = amount;
        } else {
            shares = amount * _totalSupply / _pool;
        }
        _mint(to, shares);
        emit FundsAdded(to, amount, _blockTimestamp());
    }

    /**
     * @notice Begin the withdrawal process
    */
    function unbondShares(uint shares) external {
        address usr = _msgSender();
        require(shares <= balanceOf(usr), "unbonding_too_much");
        uint _now = _blockTimestamp();
        uint unbondTime = ((_now + unbondPeriod) / unbondRoundOff) * unbondRoundOff;
        unbond[usr] = UnbondInfo(shares, unbondTime);
        emit Unbonded(usr, shares, unbondTime, _now);
    }

    /**
     * @notice Withdraw funds after unbonding period is over
    */
    function withdraw(uint shares) external {
        address user = _msgSender();
        _withdrawFor(user, shares, user);
    }

    /**
     * @notice Priviliged withdraw function used by the MarginAccountHelper to unwrap the tokens before sending it to the user
    */
    function withdrawFor(address user, uint shares) override external onlyMarginAccountHelper returns (uint) {
        return _withdrawFor(user, shares, marginAccountHelper);
    }

    /**
     * @notice Margin Account contract calls this function to seize bad debt
    */
    function seizeBadDebt(uint amount) override external onlyMarginAccount {
        pendingObligation += amount;
        emit BadDebtAccumulated(amount, block.timestamp);
        settlePendingObligation();
    }

    /**
     * @notice Sometimes the insurance fund may be in deficit and there might not be enough vusd to settle the obligation.
     * Using this function obligation can be settled with future fees.
    */
    function settlePendingObligation() public {
        if (pendingObligation > 0) {
            uint toTransfer = Math.min(vusd.balanceOf(address(this)), pendingObligation);
            if (toTransfer > 0) {
                pendingObligation -= toTransfer;
                vusd.safeTransfer(marginAccount, toTransfer);
            }
        }
    }

    /**
     * @notice Insurance fund starts an auction for assets seized from a bad debt settlement
     * @param token token to auction
    */
    function startAuction(address token) override external onlyMarginAccount {
        if(!_isAuctionOngoing(auctions[token].startedAt, auctions[token].expiryTime)) {
            uint currentPrice = uint(oracle.getUnderlyingPrice(token));
            uint currentTimestamp = _blockTimestamp();
            auctions[token] = Auction(
                currentPrice * startPriceMultiplier / PRECISION,
                currentTimestamp,
                currentTimestamp + auctionDuration
            );
        }
    }

    /**
    * @notice buy collateral from ongoing auction at current auction price
    * @param token token to buy
    * @param amount amount to buy
    */
    function buyCollateralFromAuction(address token, uint amount) override external {
        Auction memory auction = auctions[token];
        // validate auction
        require(_isAuctionOngoing(auction.startedAt, auction.expiryTime), "IF.no_ongoing_auction");

        // transfer funds
        uint vusdToTransfer = _calcVusdAmountForAuction(auction, token, amount);
        address buyer = _msgSender();
        vusd.safeTransferFrom(buyer, address(this), vusdToTransfer);
        IERC20(token).safeTransfer(buyer, amount); // will revert if there wasn't enough amount as requested

        // close auction if no collateral left
        if (IERC20(token).balanceOf(address(this)) == 0) {
            auctions[token].startedAt = 0;
        }
    }

    /* ****************** */
    /*      Internal      */
    /* ****************** */

    function _withdrawFor(address user, uint shares, address to) internal returns (uint amount) {
        // Checks
        require(unbond[user].shares >= shares, "withdrawing_more_than_unbond");
        uint _now = _blockTimestamp();
        require(_now >= unbond[user].unbondTime, "still_unbonding");
        require(!_hasWithdrawPeriodElapsed(_now, unbond[user].unbondTime), "withdraw_period_over");

        // Effects
        settlePendingObligation();
        require(pendingObligation == 0, "IF.withdraw.pending_obligations");
        amount = balance() * shares / totalSupply();
        unchecked { unbond[user].shares -= shares; }
        _burn(user, shares);

        // Interactions
        vusd.safeTransfer(to, amount);
        emit FundsWithdrawn(user, amount, _now);
    }

    /* ****************** */
    /*        View        */
    /* ****************** */

    /**
    * @notice Just a vanity function
    * @return The hUSD amount backing each Insurance Fund share
    */
    function pricePerShare() external view returns (uint) {
        uint _totalSupply = totalSupply();
        uint _balance = balance();
        _balance -= Math.min(_balance, pendingObligation);
        if (_totalSupply == 0 || _balance == 0) {
            return PRECISION;
        }
        return _balance * PRECISION / _totalSupply;
    }

    function getAuctionPrice(address token) external view returns (uint) {
        Auction memory auction = auctions[token];
        if (_isAuctionOngoing(auction.startedAt, auction.expiryTime)) {
            return _getAuctionPrice(auction);
        }
        return 0;
    }

    function calcVusdAmountForAuction(address token, uint amount) override external view returns(uint) {
        Auction memory auction = auctions[token];
        return _calcVusdAmountForAuction(auction, token, amount);
    }

    function isAuctionOngoing(address token) external view returns (bool) {
        return _isAuctionOngoing(auctions[token].startedAt, auctions[token].expiryTime);
    }

    function balance() public view returns (uint) {
        return vusd.balanceOf(address(this));
    }

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    function _blockTimestamp() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    /* ****************** */
    /*   Internal View    */
    /* ****************** */

    function _beforeTokenTransfer(address from, address to, uint256 amount) override internal view {
        if (from == address(0) || to == address(0)) return; // gas optimisation for _mint and _burn
        if (!_hasWithdrawPeriodElapsed(_blockTimestamp(), unbond[from].unbondTime)) {
            require(amount <= balanceOf(from) - unbond[from].shares, "shares_are_unbonding");
        }
    }

    function _hasWithdrawPeriodElapsed(uint _now, uint _unbondTime) internal view returns (bool) {
        return _now > (_unbondTime + withdrawPeriod);
    }

    function _getAuctionPrice(Auction memory auction) internal view returns (uint) {
        uint diff = auction.startPrice * (_blockTimestamp() - auction.startedAt) / auctionDuration;
        return auction.startPrice - diff;
    }

    function _isAuctionOngoing(uint startedAt, uint expiryTime) internal view returns (bool) {
        if (startedAt == 0) return false;
        uint currentTimestamp = _blockTimestamp();
        return startedAt <= currentTimestamp && currentTimestamp <= expiryTime;
    }

    function _calcVusdAmountForAuction(Auction memory auction, address token, uint amount) internal view returns(uint) {
        uint price = _getAuctionPrice(auction);
        uint _decimals = ERC20Detailed(token).decimals();  // will fail if .decimals() is not defined on the contract
        return amount * price / 10 ** _decimals;
    }

    function _totalPoolValue() internal view returns (uint totalBalance) {
        IMarginAccount.Collateral[] memory assets = IMarginAccount(marginAccount).supportedAssets();

        for (uint i; i < assets.length; i++) {
            uint _balance = IERC20(address(assets[i].token)).balanceOf(address(this));
            if (_balance == 0) continue;

            uint numerator = _balance * uint(oracle.getUnderlyingPrice(address(assets[i].token)));
            uint denomDecimals = assets[i].decimals;

            totalBalance += (numerator / 10 ** denomDecimals);
        }
    }

    /* ****************** */
    /*   onlyGovernance   */
    /* ****************** */

    function syncDeps(address _registry) public onlyGovernance {
        IRegistry registry = IRegistry(_registry);
        vusd = IERC20(registry.vusd());
        marginAccount = registry.marginAccount();
        oracle = IOracle(registry.oracle());
        marginAccountHelper = registry.marginAccountHelper();
    }
}
