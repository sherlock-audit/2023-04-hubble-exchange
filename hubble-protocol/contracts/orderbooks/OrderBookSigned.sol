// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { ECDSAUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/draft-EIP712Upgradeable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { VanillaGovernable } from "../legos/Governable.sol";
import { IClearingHouse, IOrderBook, IAMM, IMarginAccount } from "../Interfaces.sol";

/**
 * @title Support off-chain signed order
 * WIP
*/
contract OrderBookSigned is VanillaGovernable, Pausable, EIP712Upgradeable {
    using SafeCast for uint256;
    using SafeCast for int256;

    struct Order {
        uint256 ammIndex;
        address trader;
        int256 baseAssetQuantity;
        uint256 price;
        uint256 salt;
        bool reduceOnly;
        uint256 validUntil;
    }

    // enum OrderExecutionMode {
    //     Taker,
    //     Maker,
    //     SameBlock,
    //     Liquidation
    // }

    // keccak256("Order(uint256 ammIndex,address trader,int256 baseAssetQuantity,uint256 price,uint256 salt,bool reduceOnly)");
    bytes32 public constant ORDER_TYPEHASH = 0x0a2e4d36552888a97d5a8975ad22b04e90efe5ea0a8abb97691b63b431eb25d2;

    IClearingHouse public immutable clearingHouse;

    mapping(address => bool) public isValidator;

    // cache some variables for quick assertions
    int256[] public minSizes; // min size for each AMM, array index is the ammIndex

    uint256[50] private __gap;

    modifier onlyValidator {
        require(isValidator[msg.sender], "OB.only_validator");
        _;
    }

    modifier onlyClearingHouse {
        require(msg.sender == address(clearingHouse), "OB.only_clearingHouse");
        _;
    }

    constructor(address _clearingHouse) {
        clearingHouse = IClearingHouse(_clearingHouse);
    }

    function initialize(
        string memory _name,
        string memory _version,
        address _governance
    ) external initializer {
        __EIP712_init(_name, _version);
        // this is problematic for re-initialization but as long as we are not changing gov address across runs, it wont be a problem
        _setGovernace(_governance);
    }

    /**
     * Execute matched orders
     * @param orders It is required that orders[0] is a LONG and orders[1] is a SHORT
     * @param signatures To verify authenticity of the order
     * @param fillAmount Amount to be filled for each order. This is to support partial fills.
     *        Should be non-zero multiple of minSizeRequirement (validated in _verifyOrder)
     */
    function executeMatchedOrders(
        Order[2] memory orders,
        bytes[2] memory signatures,
        int256 fillAmount
    )   // override
        external
        view
        whenNotPaused
        onlyValidator
    {
        IOrderBook.MatchInfo[2] memory matchInfo;
        matchInfo[0].orderHash = _validateOrder(orders[0], signatures[0]);
        matchInfo[1].orderHash = _validateOrder(orders[1], signatures[1]);
        _executeMatchedOrders(orders, matchInfo, fillAmount);
    }

    function _validateOrder(Order memory order, bytes memory signature) internal view returns(bytes32 orderHash) {
        (,orderHash) = verifySigner(order, signature);
        require(order.validUntil > block.timestamp, "OB_order_expired");
    }

    /**
     * Execute matched orders
     * @param orders It is required that orders[0] is a LONG and orders[1] is a SHORT
     * @param fillAmount Amount to be filled for each order. This is to support partial fills.
     *        Should be non-zero multiple of minSizeRequirement (validated in _verifyOrder)
    */
    function _executeMatchedOrders(
        Order[2] memory orders,
        IOrderBook.MatchInfo[2] memory matchInfo,
        int256 fillAmount
    )   internal
        view
    {
        // Checks and Effects
        require(orders[0].baseAssetQuantity > 0, "OB_order_0_is_not_long");
        require(orders[1].baseAssetQuantity < 0, "OB_order_1_is_not_short");
        require(orders[0].price /* buy */ >= orders[1].price /* sell */, "OB_orders_do_not_match");
        require(orders[0].ammIndex == orders[1].ammIndex, "OB_orders_for_different_amms");
        // fillAmount should be multiple of min size requirement and fillAmount should be non-zero
        require(isMultiple(fillAmount, minSizes[orders[0].ammIndex]), "OB.not_multiple");

        // Interactions
        // Bulls (Longs) are our friends. We give them a favorable price in this corner case
        // uint fulfillPrice = orders[1].price;
        matchInfo[0].mode = IOrderBook.OrderExecutionMode.SameBlock;
        matchInfo[1].mode = IOrderBook.OrderExecutionMode.SameBlock;

        // TBD
        // try clearingHouse.openComplementaryPositions(orders, matchInfo, fillAmount, fulfillPrice) {
        //     // get openInterestNotional for indexing
        //     IAMM amm = clearingHouse.amms(orders[0].ammIndex);
        //     uint openInterestNotional = amm.openInterestNotional();
        //     // emit OrdersMatched(matchInfo[0].orderHash, matchInfo[1].orderHash, fillAmount.toUint256() /* asserts fillAmount is +ve */, fulfillPrice, openInterestNotional, msg.sender, block.timestamp);
        // } catch Error(string memory err) { // catches errors emitted from "revert/require"
        //     try this.parseMatchingError(err) returns(bytes32 orderHash, string memory reason) {
        //         // emit OrderMatchingError(orderHash, reason);
        //     } catch (bytes memory) {
        //         // abi.decode failed; we bubble up the original err
        //         revert(err);
        //     }
        //     return;
        // } /* catch (bytes memory err) {
        //     // we do not any special handling for other generic type errors
        //     // they can revert the entire tx as usual
        // } */
    }

    function parseMatchingError(string memory err) pure public returns(bytes32 orderHash, string memory reason) {
        (orderHash, reason) = abi.decode(bytes(err), (bytes32, string));
    }

    /* ****************** */
    /*      View      */
    /* ****************** */

    function verifySigner(Order memory order, bytes memory signature) public view returns (address, bytes32) {
        bytes32 orderHash = getOrderHash(order);
        address signer = ECDSAUpgradeable.recover(orderHash, signature);

        // OB_SINT: Signer Is Not Trader
        require(signer == order.trader, "OB_SINT");

        return (signer, orderHash);
    }

    function getOrderHash(Order memory order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, order)));
    }

    /* ****************** */
    /*        Pure        */
    /* ****************** */

    function abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
    }

    /**
    * @notice returns true if x and y have opposite signs
    * @dev it considers 0 to have positive sign
    */
    function isOppositeSign(int256 x, int256 y) internal pure returns (bool) {
        return (x ^ y) < 0;
    }

    /**
    * @notice returns true if x and y have same signs
    * @dev it considers 0 to have positive sign
    */
    function isSameSign(int256 x, int256 y) internal pure returns (bool) {
        return (x ^ y) >= 0;
    }

    /**
    * @notice returns true if x is multiple of y and abs(x) >= y
    * @dev assumes y is positive
    */
    function isMultiple(int256 x, int256 y) internal pure returns (bool) {
        return (x != 0 && x % y == 0);
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

    function setValidatorStatus(address validator, bool status) external onlyGovernance {
        isValidator[validator] = status;
    }

    function initializeMinSize(int minSize) external onlyGovernance {
        minSizes.push(minSize);
    }

    function updateMinSize(uint ammIndex, int minSize) external onlyGovernance {
        minSizes[ammIndex] = minSize;
    }
}
