// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { HubbleBase } from "./legos/HubbleBase.sol";
import { IAMM, IMarginAccount, IClearingHouse, IHubbleReferral, IOrderBook } from "./Interfaces.sol";
import { VUSD } from "./VUSD.sol";
import { IHubbleBibliophile } from "./precompiles/IHubbleBibliophile.sol";

/**
 * @title Gets instructions from the orderbook contract and executes them.
 * Routes various actions (realizePnL, update/Liquidate Positions etc) to corresponding contracts like margin account, amm, referral etc.
 * @dev At several places we are using something called a bibliophile. This is a special contract (precompile) that is deployed at a specific address.
 * But there is identical code in this contract that can be used as a fallback if the precompile is not available.
*/
contract ClearingHouse is IClearingHouse, HubbleBase {
    using SafeCast for uint256;
    using SafeCast for int256;

    modifier onlyOrderBook() {
        require(isWhitelistedOrderBook[msg.sender], "Only orderBook");
        _;
    }

    modifier onlyDefaultOrderBook() {
        require(msg.sender == address(defaultOrderBook), "Only orderBook");
        _;
    }

    modifier onlyMySelf() {
        require(msg.sender == address(this), "Only myself");
        _;
    }

    uint256 constant PRECISION = 1e6;
    bytes32 constant public LIQUIDATION_FAILED = keccak256("LIQUIDATION_FAILED");
    int256 constant PRECISION_INT = 1e6;

    int256 override public maintenanceMargin; // SLOT_1 !!! used in precompile !!!
    int256 public minAllowableMargin; // SLOT_2 !!! used in precompile !!!
    int256 override public takerFee; // defining as int for consistency with makerFee
    int256 override public makerFee;
    uint override public liquidationPenalty;
    uint public referralShare;
    uint public tradingFeeDiscount;

    VUSD public vusd;
    address override public feeSink;
    IMarginAccount public marginAccount;
    IOrderBook public defaultOrderBook;
    IAMM[] override public amms;  // SLOT_12 !!! used in precompile !!!
    IHubbleReferral public hubbleReferral;
    uint public lastFundingTime;
    // trader => lastFundingPaid timestamp
    mapping(address => uint) public lastFundingPaid;
    IHubbleBibliophile public bibliophile;
    mapping(address => bool) public isWhitelistedOrderBook;

    uint256[50] private __gap;

    function initialize(
        address _governance,
        address _feeSink,
        address _marginAccount,
        address _defaultOrderBook,
        address _vusd,
        address _hubbleReferral
    ) external
      initializer
    {
        _setGovernace(_governance);

        feeSink = _feeSink;
        marginAccount = IMarginAccount(_marginAccount);
        defaultOrderBook = IOrderBook(_defaultOrderBook);
        vusd = VUSD(_vusd);
        hubbleReferral = IHubbleReferral(_hubbleReferral);
        isWhitelistedOrderBook[_defaultOrderBook] = true;
    }

    /* ****************** */
    /*     Positions      */
    /* ****************** */

    /**
     * @notice Pass instructions to the AMM contract to open/close/modify the position in a market.
     * Can only be called by the orderBook contract.
     * @dev reverts the all the state storage updates within the context of this call (and sub-calls) if an intermediate step of the call fails
     * @param orders orders[0] is the long order and orders[1] is the short order
     * @param matchInfo intermediate information about which order came first and which eventually decides what fee to charge
     * @param fillAmount Amount of base asset to be traded between the two orders. Should be +ve. Scaled by 1e18
     * @param fulfillPrice Price at which the orders should be matched. Scaled by 1e6.
     * @return openInterest The total open interest in the market after the trade is executed
    */
    function openComplementaryPositions(
        IOrderBook.Order[2] calldata orders,
        IOrderBook.MatchInfo[2] calldata matchInfo,
        int256 fillAmount,
        uint fulfillPrice
    )   external
        onlyOrderBook
        returns (uint256 openInterest)
    {

        try this.openPosition(orders[0], fillAmount, fulfillPrice, matchInfo[0].mode, false) {
            // only executed if the above doesn't revert
            try this.openPosition(orders[1], -fillAmount, fulfillPrice, matchInfo[1].mode, true) returns(uint256 _openInterest) {
                openInterest = _openInterest;
                // only executed if the above doesn't revert
            } catch Error(string memory reason) {
                // will revert all state changes including those made in this.openPosition(orders[0])
                revert(string(abi.encode(matchInfo[1].orderHash, reason)));
            }
        } catch Error(string memory reason) {
            // surface up the error to the calling contract
            revert(string(abi.encode(matchInfo[0].orderHash, reason)));
        }
    }

    // to avoid stack too deep error
    struct VarGroup {
        int256 feeCharged;
        int realizedPnl;
        bool isPositionIncreased;
    }

   /**
    * @notice Open/Modify/Close Position
    * @dev uses "onlyMySelf" modifier to make sure the calls come from within the same contract.
    * This function was designed in a manner that helps us use the try-catch feature of solidity to revert all state changes if any of the sub-calls revert.
    * @param mode Whether we are executing is a maker, taker order or a liquidation
    * @param is2ndTrade Whether this is the second trade in a pair of trades that are executed together, which is used to update the twap in the AMM contract
    */
    function openPosition(IOrderBook.Order calldata order, int256 fillAmount, uint256 fulfillPrice, IOrderBook.OrderExecutionMode mode, bool is2ndTrade) public onlyMySelf returns(uint openInterest) {
        return _openPosition(order, fillAmount, fulfillPrice, mode, is2ndTrade);
    }

    function _openPosition(IOrderBook.Order memory order, int256 fillAmount, uint256 fulfillPrice, IOrderBook.OrderExecutionMode mode, bool is2ndTrade) internal returns(uint openInterest) {
        updatePositions(order.trader); // settle funding payments
        uint quoteAsset = abs(fillAmount).toUint256() * fulfillPrice / 1e18;
        int size;
        uint openNotional;
        VarGroup memory varGroup;
        (
            varGroup.realizedPnl,
            varGroup.isPositionIncreased,
            size,
            openNotional,
            openInterest
        ) = amms[order.ammIndex].openPosition(order, fillAmount, fulfillPrice, is2ndTrade);

        {
            int toFeeSink;
            (toFeeSink, varGroup.feeCharged) = _chargeFeeAndRealizePnL(order.trader, varGroup.realizedPnl, quoteAsset, mode);
            if (toFeeSink != 0) {
                marginAccount.transferOutVusd(feeSink, toFeeSink.toUint256());
            }
        }
        {
            // isPositionIncreased is true when the position is increased or reversed
            if (varGroup.isPositionIncreased) {
                assertMarginRequirement(order.trader);
                require(order.reduceOnly == false, "CH: reduceOnly order can only reduce position");
            }
            emit PositionModified(order.trader, order.ammIndex, fillAmount, fulfillPrice, varGroup.realizedPnl, size, openNotional, varGroup.feeCharged, mode, _blockTimestamp());
        }
    }

    /* ****************** */
    /*    Liquidations    */
    /* ****************** */

    /**
     * @notice Pass instructions to the AMM contract to the liquidate 1 position and open/close/modify the other in a market.
     * Can only be called by the orderBook contract.
     * @dev reverts the all the state storage updates within the context of this call (and sub-calls) if an intermediate step of the call fails
     * @param order long order if liquidating a long position, short order if liquidating a short position
     * @param matchInfo intermediate information about the order being matched
     * @param liquidationAmount -ve if liquidating a short pos, +ve if long. Scaled by 1e18
     * @param price Price at which the liquidation should be executed. Scaled by 1e6.
     * @param trader Trader being liquidated
     * @return openInterest The total open interest in the market after the liquidation is executed
    */
    function liquidate(
        IOrderBook.Order calldata order,
        IOrderBook.MatchInfo calldata matchInfo,
        int256 liquidationAmount,
        uint price,
        address trader
    )
        override
        external
        onlyOrderBook
        returns (uint256 openInterest)
    {
        try this.liquidateSingleAmm(trader, order.ammIndex, price, liquidationAmount) {
            // only executed if the above doesn't revert
            try this.openPosition(order, liquidationAmount, price, matchInfo.mode, true) returns(uint256 _openInterest) {
                openInterest = _openInterest;
            } catch Error(string memory reason) {
                // will revert all state changes including those made in this.liquidateSingleAmm
                revert(string(abi.encode(matchInfo.orderHash, reason)));
            }
        } catch Error(string memory reason) {
            // surface up the error to the calling contract
            revert(string(abi.encode(LIQUIDATION_FAILED, reason)));
        }
    }

    function liquidateSingleAmm(address trader, uint ammIndex, uint price, int toLiquidate) external onlyMySelf {
        _liquidateSingleAmm(trader, ammIndex, price, toLiquidate);
    }

    function _liquidateSingleAmm(address trader, uint ammIndex, uint price, int toLiquidate) internal {
        updatePositions(trader); // settle funding payments
        _assertLiquidationRequirement(trader);
        (
            int realizedPnl,
            uint quoteAsset,
            int size,
            uint openNotional
        ) = amms[ammIndex].liquidatePosition(trader, price, toLiquidate);

        (int liquidationFee,) = _chargeFeeAndRealizePnL(trader, realizedPnl, quoteAsset, IOrderBook.OrderExecutionMode.Liquidation);
        marginAccount.transferOutVusd(feeSink, liquidationFee.toUint256()); // will revert if liquidationFee is negative
        emit PositionLiquidated(trader, ammIndex, toLiquidate, price, realizedPnl, size, openNotional, liquidationFee, _blockTimestamp());
    }

    /* ****************** */
    /*  Funding Payments  */
    /* ****************** */

    /**
     * @notice Settle unrealized funding payments for a trader
     * @dev Interestingly, anyone can call this function to settle funding payments for a trader
     * Note, that as long as this function is called before the user attempts to remove margin;
     * it is not strictly necessary to call this function on every trade for a trader, however we still currently do so. Might explore avoiding this in the future.
    */
    function updatePositions(address trader) override public whenNotPaused {
        require(address(trader) != address(0), 'CH: 0x0 trader Address');
        // lastFundingTime will always be >= lastFundingPaid[trader]
        if (lastFundingPaid[trader] != lastFundingTime) {
            int256 fundingPayment;
            uint numAmms = amms.length;
            for (uint i; i < numAmms; ++i) {
                (int256 _fundingPayment, int256 cumulativePremiumFraction) = amms[i].updatePosition(trader);
                if (_fundingPayment != 0) {
                    fundingPayment += _fundingPayment;
                    emit FundingPaid(trader, i, _fundingPayment, cumulativePremiumFraction);
                }
            }
            // -ve fundingPayment means trader should receive funds
            marginAccount.realizePnL(trader, -fundingPayment);
            lastFundingPaid[trader] = lastFundingTime;
        }
    }

    function settleFunding() override external onlyDefaultOrderBook {
        uint numAmms = amms.length;
        uint _nextFundingTime;
        for (uint i; i < numAmms; ++i) {
            int _premiumFraction;
            int _underlyingPrice;
            int _cumulativePremiumFraction;
            (_premiumFraction, _underlyingPrice, _cumulativePremiumFraction, _nextFundingTime) = amms[i].settleFunding();
            if (_nextFundingTime != 0) {
                emit FundingRateUpdated(
                    i,
                    _premiumFraction,
                    _underlyingPrice.toUint256(),
                    _cumulativePremiumFraction,
                    _nextFundingTime,
                    _blockTimestamp(),
                    block.number
                );
            }
        }
        // nextFundingTime will be same for all amms
        if (_nextFundingTime != 0) {
            lastFundingTime = _blockTimestamp();
        }
    }

    /* ********************* */
    /*        Internal       */
    /* ********************* */

    /**
    * @notice calculate trade/liquidatin fee
    * referral bonus and fee discount is applied when positive fee is charged from either maker or taker
    * @param realizedPnl realized PnL of the trade, only sent in so that call an extra call to marginAccount.realizePnL can be saved
    * @return toFeeSink fee to be sent to fee sink, always >= 0
    * @return feeCharged total fee including referral bonus and maker fee, can be positive or negative. -ve implies maker rebate.
    */
    function _chargeFeeAndRealizePnL(
        address trader,
        int realizedPnl,
        uint quoteAsset,
        IOrderBook.OrderExecutionMode mode
    )
        internal
        returns (int toFeeSink, int feeCharged)
    {
        if (mode == IOrderBook.OrderExecutionMode.Taker) {
            feeCharged = _calculateTakerFee(quoteAsset);
            if (makerFee < 0) {
                // when maker fee is -ve, don't send to fee sink
                // it will be credited to the maker when processing the other side of the trade
                toFeeSink = _calculateMakerFee(quoteAsset); // toFeeSink is now -ve
            }
        } else if (mode == IOrderBook.OrderExecutionMode.SameBlock) {
            // charge taker fee without expecting a corresponding maker component
            feeCharged = _calculateTakerFee(quoteAsset);
        } else if (mode == IOrderBook.OrderExecutionMode.Maker) {
            feeCharged = _calculateMakerFee(quoteAsset); // can be -ve or +ve
        }  else if (mode == IOrderBook.OrderExecutionMode.Liquidation){
            feeCharged = _calculateLiquidationPenalty(quoteAsset);
            if (makerFee < 0) {
                // when maker fee is -ve, don't send to fee sink
                // it will be credited to the maker when processing the other side of the trade
                toFeeSink = _calculateMakerFee(quoteAsset);
            }
        }

        if (feeCharged > 0) {
            toFeeSink += feeCharged;
            if (mode != IOrderBook.OrderExecutionMode.Liquidation) {
                (uint discount, uint referralBonus) = _payReferralBonus(trader, feeCharged.toUint256());
                feeCharged -= discount.toInt256();
                // deduct referral bonus (already credit to referrer) from fee sink share
                toFeeSink = toFeeSink - discount.toInt256() - referralBonus.toInt256();
            }
        }

        marginAccount.realizePnL(trader, realizedPnl - feeCharged);
    }

    /**
     * @param feeCharged fee charged to the trader, caller makes sure that this is positive
    */
    function _payReferralBonus(address trader, uint feeCharged) internal returns(uint discount, uint referralBonus) {
        address referrer = hubbleReferral.getTraderRefereeInfo(trader);
        if (referrer != address(0x0)) {
            referralBonus = feeCharged * referralShare / PRECISION;
            // add margin to the referrer
            // note that this fee will be deducted from the fee sink share in the calling function
            marginAccount.realizePnL(referrer, referralBonus.toInt256());
            emit ReferralBonusAdded(referrer, referralBonus);

            discount = feeCharged * tradingFeeDiscount / PRECISION;
        }
    }

    /* ****************** */
    /*        View        */
    /* ****************** */

    function calcMarginFraction(address trader, bool includeFundingPayments, Mode mode) public view returns(int256) {
        (uint256 notionalPosition, int256 margin) = getNotionalPositionAndMargin(trader, includeFundingPayments, mode);
        return _getMarginFraction(margin, notionalPosition);
    }

    function getTotalFunding(address trader) override public view returns(int256 totalFunding) {
        int256 fundingPayment;
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            (fundingPayment,) = amms[i].getPendingFundingPayment(trader);
            totalFunding += fundingPayment;
        }
    }

    function getTotalNotionalPositionAndUnrealizedPnl(address trader, int256 margin, Mode mode)
        override
        public
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl)
    {
        uint256 _notionalPosition;
        int256 _unrealizedPnl;
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            (_notionalPosition, _unrealizedPnl) = amms[i].getOptimalPnl(trader, margin, mode);
            notionalPosition += _notionalPosition;
            unrealizedPnl += _unrealizedPnl;
        }
    }

    function getNotionalPositionAndMargin(address trader, bool includeFundingPayments, Mode mode)
        override
        public
        view
        returns(uint256 notionalPosition, int256 margin)
    {
        if (address(bibliophile) != address(0x0)) {
            // precompile magic allows us to execute this for a fixed 1k gas
            return bibliophile.getNotionalPositionAndMargin(trader, includeFundingPayments, uint8(mode));
        }
        return getNotionalPositionAndMarginVanilla(trader, includeFundingPayments, mode);
    }

    /**
     * @dev fallback if the precompile is not available
    */
    function getNotionalPositionAndMarginVanilla(address trader, bool includeFundingPayments, Mode mode)
        public
        view
        returns(uint256 notionalPosition, int256 margin)
    {
        int256 unrealizedPnl;
        margin = marginAccount.getNormalizedMargin(trader);
        if (includeFundingPayments) {
            margin -= getTotalFunding(trader); // -ve fundingPayment means trader should receive funds
        }
        (notionalPosition, unrealizedPnl) = getTotalNotionalPositionAndUnrealizedPnl(trader, margin, mode);
        margin += unrealizedPnl;
    }

    /**
    * @dev This method assumes that pending funding has been settled
    */
    function assertMarginRequirement(address trader) public view {
        require(
            calcMarginFraction(trader, false, Mode.Min_Allowable_Margin) >= minAllowableMargin,
            "CH: Below Minimum Allowable Margin"
        );
    }

    function getAmmsLength() override public view returns(uint) {
        return amms.length;
    }

    function getAMMs() external view returns (IAMM[] memory) {
        return amms;
    }

    /* ****************** */
    /*   Test/UI Helpers  */
    /* ****************** */

    function isAboveMaintenanceMargin(address trader) override external view returns(bool) {
        return calcMarginFraction(trader, true, Mode.Maintenance_Margin) >= maintenanceMargin;
    }

    function orderBook() external view returns(IOrderBook) {
        return defaultOrderBook;
    }

    /**
     * @notice Get the underlying price of the AMMs
    */
    function getUnderlyingPrice() override public view returns(uint[] memory prices) {
        uint numAmms = amms.length;
        prices = new uint[](numAmms);
        for (uint i; i < numAmms; ++i) {
            prices[i] = amms[i].getUnderlyingPrice();
        }
    }

    /* ****************** */
    /*   Internal View    */
    /* ****************** */

    /**
    * @dev This method assumes that pending funding has been credited
    */
    function _assertLiquidationRequirement(address trader) internal view {
        require(calcMarginFraction(trader, false, Mode.Maintenance_Margin) < maintenanceMargin, "CH: Above Maintenance Margin");
    }

    function _calculateTradeFee(uint quoteAsset, bool isMakerOrder) internal view returns (int) {
        if (isMakerOrder) {
            return _calculateMakerFee(quoteAsset);
        }
        return quoteAsset.toInt256() * takerFee / PRECISION_INT;
    }

    function _calculateTakerFee(uint quoteAsset) internal view returns (int) {
        return quoteAsset.toInt256() * takerFee / PRECISION_INT;
    }

    function _calculateMakerFee(uint quoteAsset) internal view returns (int) {
        return quoteAsset.toInt256() * makerFee / PRECISION_INT;
    }

    function _calculateLiquidationPenalty(uint quoteAsset) internal view returns (int) {
        return (quoteAsset * liquidationPenalty / PRECISION).toInt256();
    }

    /* ****************** */
    /*        Pure        */
    /* ****************** */

    function _getMarginFraction(int256 accountValue, uint notionalPosition) private pure returns(int256) {
        if (notionalPosition == 0) {
            return type(int256).max;
        }
        return accountValue * PRECISION.toInt256() / notionalPosition.toInt256();
    }

    function abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function whitelistAmm(address _amm) external virtual onlyGovernance {
        require(address(IAMM(_amm).oracle()) != address(0), "ch.whitelistAmm.oracle_not_set");
        uint minSize = IAMM(_amm).minSizeRequirement();
        require(minSize > 0, "ch.whitelistAmm.minSizeRequirement_not_set");

        uint l = amms.length;
        for (uint i; i < l; ++i) {
            require(address(amms[i]) != _amm, "ch.whitelistAmm.duplicate_amm");
        }
        emit MarketAdded(l, _amm);
        amms.push(IAMM(_amm));
        uint nextFundingTime = IAMM(_amm).startFunding();
        // to start funding in vm
        emit FundingRateUpdated(
            l,
            0,
            IAMM(_amm).lastPrice(),
            0,
            nextFundingTime,
            _blockTimestamp(),
            block.number
        );
    }

    function setParams(
        int _maintenanceMargin,
        int _minAllowableMargin,
        int _takerFee,
        int _makerFee,
        uint _referralShare,
        uint _tradingFeeDiscount,
        uint _liquidationPenalty
    ) external onlyGovernance {
        require(_maintenanceMargin > 0, "_maintenanceMargin <= 0");
        require(_liquidationPenalty > 0, "_liquidationPenalty < 0");

        maintenanceMargin = _maintenanceMargin;
        minAllowableMargin = _minAllowableMargin;
        takerFee = _takerFee;
        makerFee = _makerFee;
        referralShare = _referralShare;
        tradingFeeDiscount = _tradingFeeDiscount;
        liquidationPenalty = _liquidationPenalty;

        defaultOrderBook.updateParams(_minAllowableMargin.toUint256(), _takerFee.toUint256());
        marginAccount.updateParams(_minAllowableMargin.toUint256());
    }

    function setBibliophile(address _bibliophile) external onlyGovernance {
        bibliophile = IHubbleBibliophile(_bibliophile);
    }
}
