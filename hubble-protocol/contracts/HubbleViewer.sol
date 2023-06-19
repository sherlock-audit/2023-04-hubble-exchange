// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IClearingHouse, IMarginAccount, IAMM, IHubbleViewer } from "./Interfaces.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

contract HubbleViewer is IHubbleViewer {
    using SafeCast for uint256;
    using SafeCast for int256;

    int256 constant PRECISION_INT = 1e6;
    uint256 constant PRECISION_UINT = 1e6;

    uint constant VUSD_IDX = 0;

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable marginAccount;

    /// @dev not actually used but helps in utils.generateConfig
    address public immutable registry;

    struct Position {
        int256 size;
        uint256 openNotional;
        int256 unrealizedPnl;
        uint256 avgOpen;
        int256 funding;
    }

    /// @dev UI Helper
    struct MarketInfo {
        address amm;
        address underlying;
    }

    constructor(
        address _clearingHouse,
        address _marginAccount,
        address _registry
    ) {
        clearingHouse = IClearingHouse(_clearingHouse);
        marginAccount = IMarginAccount(_marginAccount);
        registry = _registry;
    }

    function getMarginFractions(address[] calldata traders)
        external
        view
        returns(int256[] memory fractions)
    {
        uint len = traders.length;
        fractions = new int256[](len);
        for (uint i; i < len; i++) {
            fractions[i] = clearingHouse.calcMarginFraction(traders[i], true, IClearingHouse.Mode.Maintenance_Margin);
        }
    }

    function marginAccountLiquidatationStatus(address[] calldata traders)
        external
        view
        returns(IMarginAccount.LiquidationStatus[] memory isLiquidatable, uint[] memory repayAmount, uint[] memory incentivePerDollar)
    {
        isLiquidatable = new IMarginAccount.LiquidationStatus[](traders.length);
        repayAmount = new uint[](traders.length);
        incentivePerDollar = new uint[](traders.length);
        for (uint i; i < traders.length; i++) {
            (isLiquidatable[i], repayAmount[i], incentivePerDollar[i]) = marginAccount.isLiquidatable(traders[i], true);
        }
    }

    /**
    * @notice Get open position information for each AMM
    * @param trader Trader for which information is to be obtained
    * @return positions in order of amms
    *   positions[i].size - BaseAssetQuantity amount longed (+ve) or shorted (-ve)
    *   positions[i].openNotional - $ value of position
    *   positions[i].unrealizedPnl - in dollars. +ve is profit, -ve if loss
    *   positions[i].avgOpen - Average $ value at which position was started
    */
    function userPositions(address trader) external view returns(Position[] memory positions) {
        uint l = clearingHouse.getAmmsLength();
        positions = new Position[](l);
        for (uint i; i < l; i++) {
            IAMM amm = clearingHouse.amms(i);
            (positions[i].size, positions[i].openNotional,,) = amm.positions(trader);
            if (positions[i].size == 0) {
                positions[i].unrealizedPnl = 0;
                positions[i].avgOpen = 0;
            } else {
                (,positions[i].unrealizedPnl) = amm.getNotionalPositionAndUnrealizedPnl(trader);
                positions[i].avgOpen = positions[i].openNotional * 1e18 / _abs(positions[i].size).toUint256();
            }
        }
    }

    function markets() external view returns(MarketInfo[] memory _markets) {
        uint l = clearingHouse.getAmmsLength();
        _markets = new MarketInfo[](l);
        for (uint i; i < l; i++) {
            IAMM amm = clearingHouse.amms(i);
            _markets[i] = MarketInfo(address(amm), amm.underlyingAsset());
        }
    }

    /**
    * @notice calculate amount of quote asset required for trade
    * @param baseAssetQuantity base asset to long/short
    * @param idx amm index
    */
    function getQuote(int256 baseAssetQuantity, uint idx) public view returns(uint256 quoteAssetQuantity) {
        IAMM amm = clearingHouse.amms(idx);
        quoteAssetQuantity = _abs(baseAssetQuantity).toUint256() * amm.lastPrice() / 1e18;
    }

    /**
    * @notice calculate amount of base asset required for trade
    * @param quoteAssetQuantity amount of quote asset to long/short
    * @param idx amm index
    * @param isLong long - true, short - false
    */
    function getBase(uint256 quoteAssetQuantity, uint idx, bool isLong) external view returns(int256 /* baseAssetQuantity */) {
        IAMM amm = clearingHouse.amms(idx);

        uint256 baseAssetQuantity = quoteAssetQuantity * PRECISION_UINT / amm.lastPrice();
        if (isLong) {
            return baseAssetQuantity.toInt256();
        }
        return -(baseAssetQuantity.toInt256());
    }

    /**
    * @notice get user margin for all collaterals
    */
    function userInfo(address trader) external view returns(int256[] memory) {
        uint length = marginAccount.supportedAssetsLen();
        int256[] memory _margin = new int256[](length);
        // -ve funding means user received funds
        _margin[VUSD_IDX] = marginAccount.margin(VUSD_IDX, trader) - clearingHouse.getTotalFunding(trader);
        for (uint i = 1; i < length; i++) {
            _margin[i] = marginAccount.margin(i, trader);
        }
        return _margin;
    }

    /**
    * @notice get user account information
    */
    function getAccountInfo(address trader) external view returns (
        int totalCollateral,
        int256 freeMargin,
        int256 marginFraction,
        uint notionalPosition,
        int256 unrealizedPnl,
        int256 marginFractionLiquidation
    ) {
        marginFraction = clearingHouse.calcMarginFraction(trader, true, IClearingHouse.Mode.Min_Allowable_Margin);
        marginFractionLiquidation = clearingHouse.calcMarginFraction(trader, true, IClearingHouse.Mode.Maintenance_Margin);
        (notionalPosition, unrealizedPnl) = getMarkPriceBasedPnl(trader);

        int256 pendingFunding = clearingHouse.getTotalFunding(trader);
        // marginAccount.getAvailableMargin(trader) assumes that there is no pending funding
        freeMargin = marginAccount.getAvailableMargin(trader) - pendingFunding;
        (,totalCollateral) = marginAccount.weightedAndSpotCollateral(trader);
        totalCollateral -= pendingFunding;
    }

    function getMarkPriceBasedPnl(address trader) public view returns(uint notionalPosition, int unrealizedPnl) {
        uint numAmms = clearingHouse.getAmmsLength();
        uint256 _notionalPosition;
        int256 _unrealizedPnl;
        for (uint i; i < numAmms; i++) {
            IAMM amm = clearingHouse.amms(i);
            (_notionalPosition, _unrealizedPnl) = amm.getNotionalPositionAndUnrealizedPnl(trader);
            notionalPosition += _notionalPosition;
            unrealizedPnl += _unrealizedPnl;
        }
    }

    /**
    * @dev Vanity function required for some analyses later
    */
    function getPendingFundings(address[] calldata traders)
        external
        view
        returns(int[][] memory takerFundings)
    {
        uint l = clearingHouse.getAmmsLength();
        uint t = traders.length;
        takerFundings = new int[][](t);
        for (uint j; j < t; j++) {
            takerFundings[j] = new int[](l);
            for (uint i; i < l; i++) {
                IAMM amm = clearingHouse.amms(i);
                (takerFundings[j][i],) = amm.getPendingFundingPayment(traders[j]);
            }
        }
    }

    // Pure

    function _abs(int x) private pure returns (int) {
        return x >= 0 ? x : -x;
    }
}
