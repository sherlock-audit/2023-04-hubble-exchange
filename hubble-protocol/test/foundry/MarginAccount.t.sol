pragma solidity 0.8.9;

import "./Utils.sol";

contract MarginAccountTests is Utils {
    RestrictedErc20 public weth;
    int public constant defaultWethPrice = 1000 * 1e6;

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

    function testAvailableMargin(uint64 price, uint120 size_) public {
        vm.assume(price > 10);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE +  10 * MIN_SIZE; // to avoid min size error

        // alice longs, bob shorts
        // deposit some weth margin, not necessarily needed for this test
        int quote = size * int(uint(price)) / 1e18;
        int margin =  quote * 1e18 / defaultWethPrice / 5; // multiply by 1e18 because weth is in 18 decimals
        addMargin(alice, uint(margin), 1, address(weth));
        addMargin(bob, uint(margin), 1, address(weth));
        // next step deposits husd margin at 2x leverage
        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, false, true, size, false);
        int utilizedMargin  = quote / MAX_LEVERAGE; // max leverage = 5x
        assertAvailableMargin(alice, 0, 0, utilizedMargin);
        assertAvailableMargin(bob, 0, 0, utilizedMargin);

        // place another order to make reservedMargin non-zero
        placeOrder(0, aliceKey, size + MIN_SIZE, price, false);
        placeOrder(0, bobKey, size + MIN_SIZE, price, false);
        uint reservedMargin = orderBook.getRequiredMargin(size + MIN_SIZE, price);
        assertAvailableMargin(alice, 0, int(reservedMargin), utilizedMargin);
        assertAvailableMargin(bob, 0, int(reservedMargin), utilizedMargin);

        // execute another trade to make unrealized profit/loss non-zero
        // pump price by 10%
        uint newPrice = uint(price) * 11 / 10;
        executeTrade(0, size * 2, newPrice, true);
        int unrealizedProfit = int(newPrice) * size / 1e18 - quote;
        utilizedMargin = int(newPrice) * size / 1e18 / MAX_LEVERAGE;
        // alices gains, bob loses
        assertAvailableMargin(alice, unrealizedProfit, int(reservedMargin), utilizedMargin);
        assertAvailableMargin(bob, -unrealizedProfit, int(reservedMargin), utilizedMargin);

        // close all positions at newPrice
        placeAndExecuteOrder(0, bobKey, aliceKey, size, newPrice, false, true, size, false);
        assertAvailableMargin(alice, 0, int(reservedMargin), 0);
        assertAvailableMargin(bob, 0, int(reservedMargin), 0);
    }

    function testRemoveMargin(uint64 price, uint120 size_) public {
        vm.assume(price > 10); // reducing price by 10% later in this test
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE +  10 * MIN_SIZE; // to avoid min size error

        // alice longs, bob shorts
        int quote = size * int(uint(price)) / 1e18;
        int margin =  quote / 2; // 2x leverage
        addMargin(bob, uint(margin), 0, address(0));
        addMargin(alice, uint(margin), 0, address(0));

        IOrderBook.Order[2] memory orders;
        bytes32[] memory orderHashes = new bytes32[](2);
        (orders[0],, orderHashes[0]) = placeOrder(0, aliceKey, size, price, false);
        // cannot remove more than available margin
        uint availableMargin = uint(marginAccount.getAvailableMargin(alice));
        vm.expectRevert("MA: available margin < 0, withdrawing too much");
        vm.prank(alice);
        marginAccount.removeMargin(0, availableMargin + 1);
        // increase block number to make alice maker
        vm.roll(block.number + 1);

        // match orders
        (orders[1],, orderHashes[1]) = placeOrder(0, bobKey, -size, price, false);
        orderBook.executeMatchedOrders([orders[0], orders[1]], size);

        // execute another trade to make unrealized profit/loss non-zero
        // dump price by 10%, alices loses, bob gains
        uint newPrice = uint(price) * 9 / 10;
        executeTrade(0, size * 2, newPrice, true);

        // cannot remove more than available margin
        availableMargin = uint(marginAccount.getAvailableMargin(alice));
        vm.startPrank(alice);
        vm.expectRevert("MA: available margin < 0, withdrawing too much");
        marginAccount.removeMargin(0, availableMargin + 1);
        // can remove profit/loss + margin
        marginAccount.removeMargin(0, availableMargin - 1);
        assertEq(marginAccount.margin(0, alice), margin - int(calculateMakerFee(size, price) + availableMargin - 1));
        vm.stopPrank();

        // assert for bob
        availableMargin = uint(marginAccount.getAvailableMargin(bob));
        vm.startPrank(bob);
        vm.expectRevert("MA: available margin < 0, withdrawing too much");
        marginAccount.removeMargin(0, availableMargin + 1);
        // can remove profit/loss + margin
        marginAccount.removeMargin(0, availableMargin - 1);
        assertEq(marginAccount.margin(0, bob), margin - int(calculateTakerFee(size, price) + availableMargin - 1));
        vm.stopPrank();

        // close all positions at newPrice
        placeAndExecuteOrder(0, bobKey, aliceKey, size, newPrice, false, true, size, false);
        // can remove all margin
        margin = marginAccount.margin(0, alice);
        vm.prank(alice);
        marginAccount.removeMargin(0, uint(margin));

        margin = marginAccount.margin(0, bob);
        vm.prank(bob);
        marginAccount.removeMargin(0, uint(margin));
    }
}
