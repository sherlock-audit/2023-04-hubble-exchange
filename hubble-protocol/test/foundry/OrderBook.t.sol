// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "./Utils.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

contract OrderBookTests is Utils {
    RestrictedErc20 public weth;
    int public constant defaultWethPrice = 1000 * 1e6;

    event OrderPlaced(address indexed trader, bytes32 indexed orderHash, IOrderBook.Order order, uint timestamp);
    event OrderCancelled(address indexed trader, bytes32 indexed orderHash, uint timestamp);
    event OrdersMatched(bytes32 indexed orderHash0, bytes32 indexed orderHash1, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);
    event LiquidationOrderMatched(address indexed trader, bytes32 indexed orderHash, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);

    function setUp() public {
        setupContracts();
        // add collateral
        weth = setupRestrictedTestToken('Hubble Ether', 'WETH', 18);

        vm.startPrank(governance);
        orderBook.setValidatorStatus(address(this), true);
        oracle.setUnderlyingPrice(address(weth), defaultWethPrice);
        marginAccount.whitelistCollateral(address(weth), 1e6);
        vm.stopPrank();
    }

    function testPlaceOrder(uint128 traderKey, int size, uint price) public {
        vm.assume(
            traderKey != 0 &&
            stdMath.abs(size) >= uint(MIN_SIZE) &&
            size != type(int).min /** abs(size) fails */ &&
            price < type(uint).max / stdMath.abs(size) &&
            price > 1e6
        );
        // place order with size < minSize
        (address trader, IOrderBook.Order memory order,, bytes32 orderHash) = prepareOrder(0, traderKey, MIN_SIZE - 1, price, false);

        vm.expectRevert("OB_sender_is_not_trader");
        orderBook.placeOrder(order);

        vm.startPrank(trader);
        vm.expectRevert("OB.not_multiple");
        orderBook.placeOrder(order);
        vm.stopPrank();

        size = (size / MIN_SIZE) * MIN_SIZE;
        // place order with size > minSize but not multiple of minSize
        (trader, order,, orderHash) = prepareOrder(0, traderKey, size + 1234, price, false);

        vm.startPrank(trader);
        vm.expectRevert("OB.not_multiple");
        orderBook.placeOrder(order);
        vm.stopPrank();

        (trader, order,, orderHash) = prepareOrder(0, traderKey, size, price, false);

        uint quote = stdMath.abs(size) * price / 1e18;
        uint marginRequired = quote / 5 + quote * uint(takerFee) / 1e6;
        addMargin(trader, marginRequired - 1, 0, address(0));

        vm.startPrank(trader);
        vm.expectRevert("MA_reserveMargin: Insufficient margin");
        orderBook.placeOrder(order);
        vm.stopPrank();

        addMargin(trader, 1, 0, address(0));
        vm.startPrank(trader);
        vm.expectEmit(true, true, false, true, address(orderBook));
        emit OrderPlaced(trader, orderHash, order, block.timestamp);
        orderBook.placeOrder(order);

        vm.expectRevert("OB_Order_already_exists");
        orderBook.placeOrder(order);

        (
            uint blockPlaced,
            int filledAmount,
            uint256 reservedMargin,
            OrderBook.OrderStatus status
        ) = orderBook.orderInfo(orderHash);

        assertEq(abi.encode(order), abi.encode(order));
        assertEq(uint(status), 1); // placed
        assertEq(blockPlaced, block.number);
        assertEq(filledAmount, 0);
        assertEq(reservedMargin, marginRequired);
        assertEq(marginAccount.reservedMargin(trader), marginRequired);

        orderBook.cancelOrder(order);
        (blockPlaced, filledAmount, reservedMargin, status) = orderBook.orderInfo(orderHash);
        assertEq(blockPlaced, 0);
        assertEq(filledAmount, 0);
        assertEq(reservedMargin, 0);
        assertEq(uint(status), 3); // cancelled
        assertEq(marginAccount.reservedMargin(trader), 0);

        // cannot place same order after cancelling
        vm.expectRevert("OB_Order_already_exists");
        orderBook.placeOrder(order);
        vm.stopPrank();
    }

    // used uint32 for price here to avoid many rejections in vm.assume
    // assuming index price is fixed and mark price moves aruond it
    function testExecuteMatchedOrdersFixedIP(uint32 price, uint120 size_) public {
        {
            uint oraclePrice = uint(oracle.getUnderlyingPrice(address(wavax)));
            uint maxOracleSpreadRatio = amm.maxOracleSpreadRatio();
            uint upperLimit = oraclePrice * (1e6 + maxOracleSpreadRatio) / 1e6 - 2;
            uint lowerLimit = oraclePrice * (1e6 - maxOracleSpreadRatio) / 1e6 + 2;
            vm.assume(price < upperLimit && price > lowerLimit);
        }

        IOrderBook.Order[2] memory orders;
        bytes32[2] memory orderHashes;

        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE + MIN_SIZE; // to avoid min size error

        uint quote = stdMath.abs(size) * price / 1e18;
        addMargin(alice, quote, 0, address(0)); // 1x leverage
        addMargin(bob, quote, 0, address(0));

        (orders[0],, orderHashes[0]) = placeOrder(0, aliceKey, size, price, false);
        (orders[1],, orderHashes[1]) = placeOrder(0, bobKey, -size, price, false);

        // assert reserved margin
        uint marginRequired = quote / uint(MAX_LEVERAGE) + quote * uint(takerFee) / 1e6;
        assertEq(marginAccount.reservedMargin(alice), marginRequired);
        assertEq(marginAccount.reservedMargin(bob), marginRequired);

        vm.expectRevert("OB_filled_amount_higher_than_order_base");
        orderBook.executeMatchedOrders([orders[0], orders[1]], size + MIN_SIZE);

        vm.expectRevert("OB.not_multiple");
        orderBook.executeMatchedOrders([orders[0], orders[1]], size + 1);

        vm.expectEmit(true, true, false, true, address(orderBook));
        emit OrdersMatched(orderHashes[0], orderHashes[1], uint(size), uint(price), stdMath.abs(2 * size), address(this), block.timestamp);
        orderBook.executeMatchedOrders([orders[0], orders[1]], size);

        IOrderBook.Order memory order;
        int filledAmount;
        OrderBook.OrderStatus status;
        (temp[0] /** block placed */, filledAmount, temp[1] /** reservedMargin */, status) = orderBook.orderInfo(orderHashes[0]);
        // assert that order, blockPlaced, reservedMargin are deleted
        assertEq(abi.encode(order), abi.encode(IOrderBook.Order(0, address(0), 0, 0, 0, false)));
        assertEq(temp[0], 0);
        assertEq(filledAmount, size);
        assertEq(temp[1], 0);
        assertEq(uint(status), 2); // filled

        (temp[0] /** block placed */, filledAmount, temp[1] /** reservedMargin */, status) = orderBook.orderInfo(orderHashes[1]);
        // assert that order, blockPlaced, reservedMargin are deleted
        assertEq(abi.encode(order), abi.encode(IOrderBook.Order(0, address(0), 0, 0, 0, false)));
        assertEq(temp[0], 0);
        assertEq(filledAmount, -size);
        assertEq(temp[1], 0);
        assertEq(uint(status), 2); // filled
        // all margin is freed
        assertEq(marginAccount.reservedMargin(alice), 0);
        assertEq(marginAccount.reservedMargin(bob), 0);

        vm.expectRevert("OB_invalid_order");
        orderBook.executeMatchedOrders([orders[0], orders[1]], size);

        assertPositions(alice, size, quote, 0, quote * 1e18 / stdMath.abs(size));
        assertPositions(bob, -size, quote, 0, quote * 1e18 / stdMath.abs(size));
    }

    // assuming mark and index price move together and exactly match
    function testExecuteMatchedOrdersMovingIP(uint64 price, uint120 size_) public {
        vm.assume(price > 10);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE + 2 * MIN_SIZE; // to avoid min size error

        IOrderBook.Order[2] memory orders;
        bytes32[2] memory orderHashes;

        uint quote = stdMath.abs(size) * price / 1e18;
        addMargin(alice, quote / 2, 0, address(0)); // 2x leverage
        addMargin(bob, quote / 2, 0, address(0));

        (orders[0],, orderHashes[0]) = placeOrder(0, aliceKey, size, price, false);
        (orders[1],, orderHashes[1]) = placeOrder(0, bobKey, -size, price, false);

        // assert reserved margin
        uint marginRequired = quote / uint(MAX_LEVERAGE) + quote * uint(takerFee) / 1e6;
        assertEq(marginAccount.reservedMargin(alice), marginRequired);
        assertEq(marginAccount.reservedMargin(bob), marginRequired);

        vm.expectRevert("OB_filled_amount_higher_than_order_base");
        orderBook.executeMatchedOrders([orders[0], orders[1]], size + MIN_SIZE);

        vm.expectRevert("OB.not_multiple");
        orderBook.executeMatchedOrders([orders[0], orders[1]], size + 1);

        vm.expectEmit(true, true, false, true, address(orderBook));
        emit OrdersMatched(orderHashes[0], orderHashes[1], uint(size), uint(price), stdMath.abs(2 * size), address(this), block.timestamp);
        orderBook.executeMatchedOrders([orders[0], orders[1]], size);

        IOrderBook.Order memory order;
        int filledAmount;
        OrderBook.OrderStatus status;
        (temp[0] /** block placed */, filledAmount, temp[1] /** reservedMargin */, status) = orderBook.orderInfo(orderHashes[0]);
        // assert that order, blockPlaced, reservedMargin are deleted
        assertEq(abi.encode(order), abi.encode(IOrderBook.Order(0, address(0), 0, 0, 0, false)));
        assertEq(temp[0], 0);
        assertEq(filledAmount, size);
        assertEq(temp[1], 0);
        assertEq(uint(status), 2); // filled

        (temp[0] /** block placed */, filledAmount, temp[1] /** reservedMargin */, status) = orderBook.orderInfo(orderHashes[1]);
        // assert that order, blockPlaced, reservedMargin are deleted
        assertEq(abi.encode(order), abi.encode(IOrderBook.Order(0, address(0), 0, 0, 0, false)));
        assertEq(temp[0], 0);
        assertEq(filledAmount, -size);
        assertEq(temp[1], 0);
        assertEq(uint(status), 2); // filled
        // all margin is freed
        assertEq(marginAccount.reservedMargin(alice), 0);
        assertEq(marginAccount.reservedMargin(bob), 0);

        vm.expectRevert("OB_invalid_order");
        orderBook.executeMatchedOrders([orders[0], orders[1]], size);

        assertPositions(alice, size, quote, 0, quote * 1e18 / stdMath.abs(size));
        assertPositions(bob, -size, quote, 0, quote * 1e18 / stdMath.abs(size));
    }

    function testLiquidateAndExecuteOrder(uint64 price, uint120 size_) public {
        vm.assume(price > 10 && size_ != 0);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE +  10 * MIN_SIZE; // to avoid min size error

        // add weth margin
        temp[0] = orderBook.getRequiredMargin(size, price) * 1e18 / uint(defaultWethPrice) + 1e10; // required weth margin in 1e18, add 1e10 for any precision loss
        addMargin(alice, temp[0], 1, address(weth));
        addMargin(bob, temp[0], 1, address(weth));
        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, true, false, size, false);

        // make alice and bob in liquidatin zone
        oracle.setUnderlyingPrice(address(weth), defaultWethPrice / 10);
        assertFalse(clearingHouse.isAboveMaintenanceMargin(alice));
        assertFalse(clearingHouse.isAboveMaintenanceMargin(bob));

        address charlie;
        (charlie, temp[3] /** charlieKey */) = makeAddrAndKey("charlie");
        addMargin(charlie, stdMath.abs(size) * price / 1e18, 0, address(0));
        (IOrderBook.Order memory order,, bytes32 orderHash) = placeOrder(0, temp[3], size, price, false);

        // liquidate alice
        uint toLiquidate;
        {
            vm.roll(block.number + 1); // to avoid AMM.liquidation_not_allowed_after_trade
            (,,,uint liquidationThreshold) = amm.positions(alice);
            toLiquidate = Math.min(stdMath.abs(size), liquidationThreshold);
            toLiquidate = toLiquidate / uint(MIN_SIZE) * uint(MIN_SIZE);
        }

        vm.expectRevert("OB.not_multiple");
        orderBook.liquidateAndExecuteOrder(alice, order, toLiquidate + 1);

        vm.expectEmit(true, true, false, true, address(orderBook));
        emit LiquidationOrderMatched(address(alice), orderHash, toLiquidate, price, stdMath.abs(2 * size), address(this), block.timestamp);
        orderBook.liquidateAndExecuteOrder(alice, order, toLiquidate);

        {
            (,int filledAmount, uint reservedMargin, OrderBook.OrderStatus status) = orderBook.orderInfo(orderHash);
            assertEq(uint(status), 1);
            assertEq(filledAmount, int(toLiquidate));
            temp[1] = stdMath.abs(size) * price / 1e18; // quote
            temp[0] = temp[1] / 5 + temp[1] * uint(takerFee) / 1e6; // margin required
            assertEq(marginAccount.reservedMargin(charlie), temp[0] - temp[0] * toLiquidate / stdMath.abs(size));
            assertEq(reservedMargin, temp[0] - temp[0] * toLiquidate / stdMath.abs(size));
        }
        {
            uint liquidationPenalty = toLiquidate * price * liquidationPenalty / 1e24;
            assertEq(marginAccount.margin(0, alice), -int(calculateTakerFee(size, price) + liquidationPenalty));
            // feeSink husd balance = orderMaching fee + liquidationPenalty + tradeFee in liquidation
            assertEq(husd.balanceOf(feeSink), 2 * calculateTakerFee(size, price) + liquidationPenalty + calculateMakerFee(int(toLiquidate), price));
            // marginAccount husd balance = sum(husd margin of all accounts)
            assertEq(
                husd.balanceOf(address(marginAccount)),
                uint(marginAccount.margin(0, charlie)) // charlie margin
                - liquidationPenalty - calculateTakerFee(size, price) // alice margin
                - calculateTakerFee(size, price) // bob margin
            );
        }

        // liquidate bob
        address peter;
        {
            (peter, temp[3] /** peterKey */) = makeAddrAndKey("peter");
            addMargin(peter, stdMath.abs(size) * price / 1e18, 0, address(0));
            (order,, orderHash) = placeOrder(0, temp[3], -size, price, false);
        }
        {
            vm.expectEmit(true, false, false, true, address(orderBook));
            emit LiquidationOrderMatched(address(bob), orderHash, toLiquidate, price, stdMath.abs(2 * size), address(this), block.timestamp);
            orderBook.liquidateAndExecuteOrder(bob, order, toLiquidate);
        }
        {
            (,int filledAmount, uint reservedMargin, OrderBook.OrderStatus status) = orderBook.orderInfo(orderHash);
            assertEq(uint(status), 1);
            assertEq(filledAmount, -int(toLiquidate));
            assertEq(marginAccount.reservedMargin(peter), temp[0] - temp[0] * toLiquidate / stdMath.abs(size));
            assertEq(reservedMargin, temp[0] - temp[0] * toLiquidate / stdMath.abs(size));
        }
        {
            uint liquidationPenalty = toLiquidate * price * liquidationPenalty / 1e24;
            assertEq(marginAccount.margin(0, bob), -int(calculateTakerFee(size, price) + liquidationPenalty));
            // feeSink husd balance = orderMaching fee + 2 * (liquidationPenalty + tradeFee in liquidation)
            assertEq(husd.balanceOf(feeSink), 2 * (calculateTakerFee(size, price) + liquidationPenalty + calculateMakerFee(int(toLiquidate), price)));
            // marginAccount husd balance = sum(husd margin of all accounts)
            assertEq(
                husd.balanceOf(address(marginAccount)),
                2 * uint(marginAccount.margin(0, charlie)) // charlie + peter margin
                - 2 * (liquidationPenalty + calculateTakerFee(size, price)) // alice + bob margin
            );
        }
    }

    function testOrderCancellationWhenNotEnoughMargin(uint64 price, uint120 size_) public {
        vm.assume(price > 10);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE +  5 * MIN_SIZE; // to avoid min size error

        // alice opens position
        // add weth margin scaled to 18 decimals
        temp[0] =  uint(size) * price / uint(defaultWethPrice); // 1x leverage
        addMargin(alice, temp[0], 1, address(weth));
        addMargin(bob, temp[0], 1, address(weth));
        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, true, false, size, false);

        int quote = size * int(uint(price)) / 1e18;
        int utilizedMargin = quote / MAX_LEVERAGE; // 5x max leverage

        // alice places 2 open orders
        (IOrderBook.Order memory order1,,bytes32 orderHash1) = placeOrder(0, aliceKey, size, uint(price) + 2, false);
        uint reservedMarginForOrder1 = marginAccount.reservedMargin(alice);
        (IOrderBook.Order memory order2,,) = placeOrder(0, aliceKey, size, uint(price) + 1, false);
        uint totalReservedMargin = marginAccount.reservedMargin(alice);

        // collateral price decreases such that avaialble margin < 0
        oracle.setUnderlyingPrice(address(weth), defaultWethPrice / 3);
        assertTrue(marginAccount.getAvailableMargin(alice) < 0);
        assertAvailableMargin(alice, 0, int(totalReservedMargin), utilizedMargin);

        // other users cannot cancel order
        vm.prank(bob);
        vm.expectRevert('OB_invalid_sender');
        orderBook.cancelOrder(order1);

        // validator can cancel order1
        orderBook.cancelOrder(order1);
        {
            (uint blockPlaced, int filledAmount, uint reservedMargin, OrderBook.OrderStatus status) = orderBook.orderInfo(orderHash1);
            // assert that order, blockPlaced, reservedMargin are deleted
            assertEq(blockPlaced, 0);
            assertEq(filledAmount, 0);
            assertEq(reservedMargin, 0);
            assertEq(uint(status), 3);
            assertEq(marginAccount.reservedMargin(alice), totalReservedMargin - reservedMarginForOrder1);
        }

        {
            // alice avalable margin is > 0
            oracle.setUnderlyingPrice(address(weth), defaultWethPrice);
            assertTrue(marginAccount.getAvailableMargin(alice) >= 0);
            assertAvailableMargin(alice, 0, int(totalReservedMargin - reservedMarginForOrder1), utilizedMargin);
        }

        vm.expectRevert('OB_available_margin_not_negative');
        orderBook.cancelOrder(order2);

        // other users cannot cancel order
        vm.prank(bob);
        vm.expectRevert('OB_invalid_sender');
        orderBook.cancelOrder(order2);

        // alice can still cancel the order
        vm.startPrank(alice);
        orderBook.cancelOrder(order2);
        assertEq(marginAccount.reservedMargin(alice), 0);
        // cannot cancel already cancelled order
        vm.expectRevert('OB_Order_does_not_exist');
        orderBook.cancelOrder(order2);
        vm.stopPrank();
    }

    function testCannotExecuteMatchedOrders(uint120 price, uint120 size_) public {
        vm.assume(price > 20);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE +  MIN_SIZE; // to avoid min size error

        IOrderBook.Order[2] memory orders;
        bytes32[2] memory ordersHash;

        uint quote = stdMath.abs(size) * price / 1e18;
        addMargin(alice, quote / 2, 0, address(0)); // 2x leverage
        addMargin(bob, quote / 2, 0, address(0));

        (orders[0],, ordersHash[0]) = placeOrder(0, aliceKey, size, price, false);
        (orders[1],, ordersHash[1]) = placeOrder(0, bobKey, -size, price, false);

        orders[0].salt += 1;
        ordersHash[0] = orderBook.getOrderHash(orders[0]);
        // execute an order which is not placed
        vm.expectRevert("OB_invalid_order");
        orderBook.executeMatchedOrders([orders[0], orders[1]], size);

        orders[0].salt -= 1;
        ordersHash[0] = orderBook.getOrderHash(orders[0]);

        vm.expectRevert("OB_order_0_is_not_long");
        orderBook.executeMatchedOrders([orders[1], orders[0]], size);
        vm.expectRevert("OB_order_1_is_not_short");
        orderBook.executeMatchedOrders([orders[0], orders[0]], size);
        vm.expectRevert("OB.not_multiple");
        orderBook.executeMatchedOrders([orders[0], orders[1]], 0);

        // reduce long order price
        (orders[0],, ordersHash[0]) = placeOrder(0, aliceKey, size, price - 1, false);
        vm.expectRevert("OB_orders_do_not_match");
        orderBook.executeMatchedOrders([orders[0], orders[1]], size);
    }

    function testReduceOnly(uint64 price, uint120 size_) public {
        vm.assume(price > 10);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE +  10 * MIN_SIZE; // to avoid min size error

        // alice longs, bob shorts, fillAmount = size / 2
        int fillAmount = (size / 2) / MIN_SIZE * MIN_SIZE;
        uint requiredMargin = orderBook.getRequiredMargin(size, price);
        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, false, true, fillAmount, false);
        assertEq(marginAccount.reservedMargin(alice), requiredMargin - requiredMargin * uint(fillAmount) / uint(size));
        assertEq(marginAccount.reservedMargin(bob), requiredMargin - requiredMargin * uint(fillAmount) / uint(size));

        IOrderBook.Order[2] memory orders;
        bytes32[] memory orderHashes = new bytes32[](2);
        addMargin(alice, requiredMargin * 10, 0, address(0));
        addMargin(bob, requiredMargin * 10, 0, address(0));

        // position cannot increase for a reduce-only order
        // long order increase fail, alice longs more
        (, orders[0],, orderHashes[0]) = prepareOrder(0, aliceKey, size, price - 1, true /** reduceOnly */);
        vm.expectRevert('OB_reduce_only_order_must_reduce_position');
        vm.prank(alice);
        orderBook.placeOrder(orders[0]);
        // short order increase fail, bob shorts more
        (, orders[0],, orderHashes[0]) = prepareOrder(0, bobKey, -size, price - 1, true /** reduceOnly */);
        vm.expectRevert('OB_reduce_only_order_must_reduce_position');
        vm.prank(bob);
        orderBook.placeOrder(orders[0]);

        // position cannot reverse for a reduce-only order
        // long order reverse fail, bob longs
        (, orders[0],, orderHashes[0]) = prepareOrder(0, bobKey, size, price - 1, true /** reduceOnly */);
        vm.expectRevert('OB_reduce_only_amount_exceeded');
        vm.prank(bob);
        orderBook.placeOrder(orders[0]);
        // short order reverse fail, alice shorts
        (, orders[0],, orderHashes[0]) = prepareOrder(0, aliceKey, -size, price - 1, true /** reduceOnly */);
        vm.expectRevert('OB_reduce_only_amount_exceeded');
        vm.prank(alice);
        orderBook.placeOrder(orders[0]);

        // no margin is reserved for a reduce-only order
        uint[2] memory reservedMargin; // 0 - alice, 1 - bob
        reservedMargin[1] = marginAccount.reservedMargin(bob);
        (orders[0],, orderHashes[0]) = placeOrder(0, bobKey, fillAmount, price - 2, true /** reduceOnly */);
        assertEq(marginAccount.reservedMargin(bob), reservedMargin[1]); // no new margin reserved
        assertEq(orderBook.reduceOnlyAmount(bob, 0), fillAmount);

        reservedMargin[0] = marginAccount.reservedMargin(alice);
        (orders[1],, orderHashes[1]) = placeOrder(0, aliceKey, -fillAmount, price - 2, true /** reduceOnly */);
        assertEq(marginAccount.reservedMargin(alice), reservedMargin[0]); // no new margin reserved
        assertEq(orderBook.reduceOnlyAmount(alice, 0), fillAmount);

        // cannot place order in opposite direction if reduce-only order is present
        // existing position - long
        (, IOrderBook.Order memory order,,) = prepareOrder(0, aliceKey, -size, price, false /** reduceOnly */);
        vm.expectRevert('OB_cancel_reduce_only_order_first');
        vm.prank(alice);
        orderBook.placeOrder(order);
        // existing position - short
        (, order,,) = prepareOrder(0, bobKey, size, price, false);
        vm.expectRevert('OB_cancel_reduce_only_order_first');
        vm.prank(bob);
        orderBook.placeOrder(order);

        // position can decrease for a reduce-only order
        orderBook.executeMatchedOrders([orders[0], orders[1]], fillAmount);
        assertEq(marginAccount.reservedMargin(alice), reservedMargin[0]); // no new margin released
        assertEq(marginAccount.reservedMargin(bob), reservedMargin[1]); // no new margin released
        assertEq(orderBook.reduceOnlyAmount(alice, 0), 0);
        assertEq(orderBook.reduceOnlyAmount(bob, 0), 0);
        assertPositions(alice, 0, 0, 0, 0);
        assertPositions(bob, 0, 0, 0, 0);
    }

    function testReducOnlyWhenOrderCancellation(uint64 price, uint120 size_) public {
        vm.assume(price > 10);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE +  10 * MIN_SIZE; // to avoid min size error

        // alice longs, bob shorts, fillAmount = size / 2
        int fillAmount = (size / 2) / MIN_SIZE * MIN_SIZE;
        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, false, true, fillAmount, false);

        IOrderBook.Order[2] memory orders;
        bytes32[] memory orderHashes = new bytes32[](2);
        // place reduce-only order
        (orders[0],, orderHashes[0]) = placeOrder(0, bobKey, fillAmount, price - 2, true /** reduceOnly */);
        assertEq(orderBook.reduceOnlyAmount(bob, 0), fillAmount);

        (orders[1],, orderHashes[1]) = placeOrder(0, aliceKey, -fillAmount, price - 2, true /** reduceOnly */);
        assertEq(orderBook.reduceOnlyAmount(alice, 0), fillAmount);

        // match half order
        fillAmount = (size / 4) / MIN_SIZE * MIN_SIZE;
        orderBook.executeMatchedOrders([orders[0], orders[1]], fillAmount);
        assertApproxEqAbs(orderBook.reduceOnlyAmount(alice, 0), size / 4, uint(MIN_SIZE));
        assertApproxEqAbs(orderBook.reduceOnlyAmount(bob, 0), size / 4, uint(MIN_SIZE));

        // cancel reduce-only orders
        vm.prank(alice);
        orderBook.cancelOrder(orders[1]);
        vm.prank(bob);
        orderBook.cancelOrder(orders[0]);
        assertEq(orderBook.reduceOnlyAmount(alice, 0), 0);
        assertEq(orderBook.reduceOnlyAmount(bob, 0), 0);
    }
}
