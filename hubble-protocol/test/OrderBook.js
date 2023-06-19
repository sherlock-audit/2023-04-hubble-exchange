const utils = require('./utils')
const { BigNumber } = require('ethers')
const { expect } = require('chai')

const {
    constants: { _1e6, _1e18, ZERO },
    setupContracts,
    addMargin,
    setupRestrictedTestToken,
    filterEvent
} = utils

const orderType = {
    Order: [
        // field ordering must be the same as LIMIT_ORDER_TYPEHASH
        { name: "ammIndex", type: "uint256" },
        { name: "trader", type: "address" },
        { name: "baseAssetQuantity", type: "int256" },
        { name: "price", type: "uint256" },
        { name: "salt", type: "uint256" },
        { name: "reduceOnly", type: "bool" }
    ]
}

describe('Order Book', function () {
    before(async function () {
        signers = await ethers.getSigners()
        ;([, alice, bob] = signers)
        ;({ orderBook, usdc, oracle, weth, marginAccount, clearingHouse } = await setupContracts({ mockOrderBook: false, testClearingHouse: false }))
        domain = await getDomain()

        await orderBook.setValidatorStatus(signers[0].address, true)

        await addMargin(alice, _1e6.mul(4000))
        await addMargin(bob, _1e6.mul(4000))
    })

    it('verify signer', async function() {
        shortOrder = {
            ammIndex: ZERO,
            trader: alice.address,
            baseAssetQuantity: ethers.utils.parseEther('-5'),
            price: ethers.utils.parseUnits('1000', 6),
            salt: BigNumber.from(Date.now()),
            reduceOnly: false
        }
        tradeFee = shortOrder.baseAssetQuantity.mul(shortOrder.price).div(_1e18).mul(500).div(_1e6).abs()
        order1Hash = await orderBook.getOrderHash(shortOrder)
        signature1 = await alice._signTypedData(domain, orderType, shortOrder)
        const signer = (await orderBook.verifySigner(shortOrder, signature1))[0]
        expect(signer).to.eq(alice.address)
    })

    it('place an order', async function() {
        await expect(orderBook.placeOrder(shortOrder)).to.revertedWith('OB_sender_is_not_trader')
        shortOrder2 = JSON.parse(JSON.stringify(shortOrder))
        shortOrder2.salt = shortOrder.salt.add(1)
        shortOrder2Hash = await orderBook.getOrderHash(shortOrder2)

        shortOrder3 = JSON.parse(JSON.stringify(shortOrder))
        shortOrder3.salt = shortOrder.salt.add(2)
        shortOrder3Hash = await orderBook.getOrderHash(shortOrder3)

        const tx = await orderBook.connect(alice).placeOrders([shortOrder, shortOrder2, shortOrder3])
        const _timestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp

        await expect(tx).to.emit(orderBook, "OrderPlaced").withArgs(
            shortOrder.trader,
            order1Hash,
            Object.values(shortOrder),
            _timestamp
        )
        await expect(tx).to.emit(orderBook, "OrderPlaced").withArgs(
            shortOrder2.trader,
            shortOrder2Hash,
            Object.values(shortOrder2),
            _timestamp
        )
        await expect(tx).to.emit(orderBook, "OrderPlaced").withArgs(
            shortOrder3.trader,
            shortOrder3Hash,
            Object.values(shortOrder3),
            _timestamp
        )

        await expect(orderBook.connect(alice).placeOrder(shortOrder)).to.revertedWith('OB_Order_already_exists')
        expect((await orderBook.orderInfo(order1Hash)).status).to.eq(1) // placed
        expect((await orderBook.orderInfo(shortOrder2Hash)).status).to.eq(1) // placed
        expect((await orderBook.orderInfo(shortOrder3Hash)).status).to.eq(1) // placed
    })

    it('cancel multiple orders', async function() {
        const tx = await orderBook.connect(alice).cancelOrders([shortOrder2, shortOrder3])
        const _timestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp
        await expect(tx).to.emit(orderBook, "OrderCancelled").withArgs(
            alice.address,
            shortOrder2Hash,
            _timestamp
        )
        await expect(tx).to.emit(orderBook, "OrderCancelled").withArgs(
            alice.address,
            shortOrder3Hash,
            _timestamp
        )

        expect((await orderBook.orderInfo(shortOrder2Hash)).status).to.eq(3) // cancelled
        expect((await orderBook.orderInfo(shortOrder3Hash)).status).to.eq(3) // cancelled
    })

    it('matches orders with same price and opposite base asset quantity', async function() {
       // long order with same price and baseAssetQuantity
        longOrder = {
            ammIndex: ZERO,
            trader: bob.address,
            baseAssetQuantity: ethers.utils.parseEther('5'),
            price: ethers.utils.parseUnits('1000', 6),
            salt: BigNumber.from(Date.now()),
            reduceOnly: false
        }
        await orderBook.connect(bob).placeOrder(longOrder)
        order2Hash = await orderBook.getOrderHash(longOrder)
        const tx = await orderBook.executeMatchedOrders([longOrder, shortOrder], longOrder.baseAssetQuantity)

        const _timestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp
        await expect(tx).to.emit(orderBook, 'OrdersMatched').withArgs(
            order2Hash,
            order1Hash,
            longOrder.baseAssetQuantity,
            longOrder.price,
            longOrder.baseAssetQuantity.mul(2),
            governance,
            _timestamp
        )

        expect((await orderBook.orderInfo(order1Hash)).status).to.eq(2) // filled
        expect((await orderBook.orderInfo(order2Hash)).status).to.eq(2) // filled
        await expect(orderBook.executeMatchedOrders([longOrder, shortOrder], longOrder.baseAssetQuantity)).to.revertedWith('OB_invalid_order')
    })

    it('storage slots are as expected', async function() {
        const VAR_MARGIN_MAPPING_STORAGE_SLOT = 10 // !!! if you change this, it has to be changed in the precompile !!!
        // gets margin[0][alice]
        let storage = await ethers.provider.getStorageAt(
            marginAccount.address,
            ethers.utils.keccak256(ethers.utils.solidityPack(
                ['bytes32', 'bytes32'],
                [
                    '0x' + '0'.repeat(24) + alice.address.slice(2),
                    ethers.utils.keccak256(ethers.utils.solidityPack(['uint256', 'uint256'], [0, VAR_MARGIN_MAPPING_STORAGE_SLOT]))
                ]
            ))
        )
        expect(_1e6.mul(4000).sub(tradeFee)).to.eq(BigNumber.from(storage))

        // orderInfo
        const ORDER_INFO_SLOT = 53
        let baseOrderInfoSlot = ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'uint256'], [order1Hash, ORDER_INFO_SLOT]))
        storage = await ethers.provider.getStorageAt(
            orderBook.address,
            BigNumber.from(baseOrderInfoSlot).add(1)
        )
        expect(shortOrder.baseAssetQuantity).to.eq(BigNumber.from(storage).fromTwos(256)) // filled amount
        storage = await ethers.provider.getStorageAt(
            orderBook.address,
            BigNumber.from(baseOrderInfoSlot).add(3)
        )
        expect(BigNumber.from(storage)).to.eq(2) // Filled

        baseOrderInfoSlot = ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'uint256'], [order2Hash, ORDER_INFO_SLOT]))
        storage = await ethers.provider.getStorageAt(
            orderBook.address,
            BigNumber.from(baseOrderInfoSlot).add(1)
        )
        expect(longOrder.baseAssetQuantity).to.eq(BigNumber.from(storage)) // filled amount
        storage = await ethers.provider.getStorageAt(
            orderBook.address,
            BigNumber.from(baseOrderInfoSlot).add(3)
        )
        expect(BigNumber.from(storage)).to.eq(2) // Filled

        // gets isValidator[alice]
        const VAR_IS_VALIDATOR_MAPPING_STORAGE_SLOT = 54 // this is not used in the precompile as yet
        storage = await ethers.provider.getStorageAt(
            orderBook.address,
            ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'uint256'], ['0x' + '0'.repeat(24) + signers[0].address.slice(2), VAR_IS_VALIDATOR_MAPPING_STORAGE_SLOT]))
        )
        expect(BigNumber.from(storage)).to.eq(1) // true

        const MARK_PRICE_TWAP_DATA_SLOT = 1
        const baseSlot = BigNumber.from(ethers.utils.solidityPack(['uint256'], [MARK_PRICE_TWAP_DATA_SLOT]))
        storage = await ethers.provider.getStorageAt(amm.address, baseSlot)
        expect(BigNumber.from(storage)).to.eq(longOrder.price)
        // console.log(await ethers.provider.getStorageAt(amm.address, baseSlot.add(1))) // timestamp

        const VAR_POSITIONS_SLOT = 5
        let basePositionSlot = ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'uint256'], ['0x' + '0'.repeat(24) + bob.address.slice(2), VAR_POSITIONS_SLOT]))
        storage = await ethers.provider.getStorageAt(amm.address, basePositionSlot) // size
        expect(longOrder.baseAssetQuantity).to.eq(BigNumber.from(storage))
        storage = await ethers.provider.getStorageAt(amm.address, BigNumber.from(basePositionSlot).add(1)) // open notional
        expect(longOrder.baseAssetQuantity.mul(longOrder.price).div(_1e18)).to.eq(BigNumber.from(storage))

        // alice who has a negative position
        basePositionSlot = ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'uint256'], ['0x' + '0'.repeat(24) + alice.address.slice(2), VAR_POSITIONS_SLOT]))
        storage = await ethers.provider.getStorageAt(amm.address, basePositionSlot) // size
        expect(shortOrder.baseAssetQuantity).to.eq(BigNumber.from(storage).fromTwos(256))
        storage = await ethers.provider.getStorageAt(amm.address, BigNumber.from(basePositionSlot).add(1)) // open notional
        expect(shortOrder.baseAssetQuantity.mul(shortOrder.price).abs().div(_1e18)).to.eq(BigNumber.from(storage))

        // ClearingHouse
        const AMMS_SLOT = 12
        storage = await ethers.provider.getStorageAt(
            clearingHouse.address,
            ethers.utils.solidityPack(['uint256'], [AMMS_SLOT])
        )
        expect(1).to.eq(BigNumber.from(storage)) // 1 amm

        storage = await ethers.provider.getStorageAt(
            clearingHouse.address,
            ethers.utils.keccak256(ethers.utils.solidityPack(['uint256'], [AMMS_SLOT]))
        )
        expect(amm.address).to.eq(ethers.utils.getAddress('0x' + storage.slice(26)))
    })

    it('matches multiple long orders with same price and opposite base asset quantity with short orders', async function() {
        longOrder.salt = Date.now()
        const longOrder1 = JSON.parse(JSON.stringify(longOrder))
        const longOrder1Hash = await orderBook.getOrderHash(longOrder1)

        longOrder.salt = Date.now()
        const longOrder2 = JSON.parse(JSON.stringify(longOrder))
        const longOrder2Hash = await orderBook.getOrderHash(longOrder2)
        await orderBook.connect(bob).placeOrders([longOrder1, longOrder2])

        shortOrder.salt = Date.now()
        const shortOrder1 = JSON.parse(JSON.stringify(shortOrder))
        const shortOrder1Hash = await orderBook.getOrderHash(shortOrder1)

        shortOrder.salt = Date.now()
        const shortOrder2 = JSON.parse(JSON.stringify(shortOrder))
        const shortOrder2Hash = await orderBook.getOrderHash(shortOrder2)
        await orderBook.connect(alice).placeOrders([shortOrder1, shortOrder2])

        const filter = orderBook.filters
        let events = await orderBook.queryFilter(filter)

        expect(events[events.length - 1].event).to.eq('OrderPlaced')
        expect(events[events.length - 2].event).to.eq('OrderPlaced')
        expect(events[events.length - 3].event).to.eq('OrderPlaced')
        expect(events[events.length - 4].event).to.eq('OrderPlaced')

        // match 1
        let tx = await orderBook.executeMatchedOrders([longOrder1, shortOrder1], longOrder1.baseAssetQuantity)
        await expect(tx).to.emit(orderBook, 'OrdersMatched')

        // match 2
        tx = await orderBook.executeMatchedOrders([longOrder2, shortOrder2], longOrder2.baseAssetQuantity)
        await expect(tx).to.emit(orderBook, 'OrdersMatched')
    })

    it('liquidateAndExecuteOrder', async function() {
        // force alice in liquidation zone
        const markPrice = _1e6.mul(1180)
        await placeAndExecuteTrade(_1e18.mul(5), markPrice)
        await oracle.setUnderlyingPrice(weth.address, markPrice)
        expect(await clearingHouse.isAboveMaintenanceMargin(alice.address)).to.eq(false)
        expect(await clearingHouse.isAboveMaintenanceMargin(bob.address)).to.eq(true)
        const { size } = await amm.positions(alice.address)

        const charlie = signers[7]
        await addMargin(charlie, _1e6.mul(4000))
        const { order } = await placeOrder(size, markPrice, charlie)

        // liquidate
        const toLiquidate = size.mul(25e4).div(1e6) // 1/4th position liquidated (in multiple of minSize)
        await orderBook.liquidateAndExecuteOrder(alice.address, order, toLiquidate.abs())
        const { size: sizeAfterLiquidation } = await amm.positions(alice.address)
        expect(sizeAfterLiquidation).to.eq(size.sub(toLiquidate))
        let position = await amm.positions(charlie.address)
        expect(position.size).to.eq(size.sub(sizeAfterLiquidation))

        const fillAmount = _1e18.div(-10) // 0.1
        await orderBook.liquidateAndExecuteOrder(alice.address, order, fillAmount.abs())
        const { size: sizeAfter2ndLiquidation } = await amm.positions(alice.address)
        expect(sizeAfter2ndLiquidation).to.eq(sizeAfterLiquidation.sub(fillAmount)) // only fill amount liquidated
        position = await amm.positions(charlie.address)
        expect(position.size).to.eq(size.sub(sizeAfter2ndLiquidation))
    })
})

describe('Order Book - Error Handling', function () {
    before(async function () {
        signers = await ethers.getSigners()
        ;([, alice, bob ] = signers)
        ;({ orderBook, usdc, oracle, weth, amm, marginAccount } = await setupContracts({ mockOrderBook: false }))
        domain = await getDomain()

        await orderBook.setValidatorStatus(signers[0].address, true)
        // add collateral
        wavax = await setupRestrictedTestToken('Hubble Avax', 'hWAVAX', 18)
        initialAvaxPrice = 1e6 * 10// $10
        await oracle.setUnderlyingPrice(wavax.address, initialAvaxPrice)
        await marginAccount.whitelistCollateral(wavax.address, 0.7 * 1e6) // weight = 0.7
        // add margin for alice
        const wavaxMargin = _1e18.mul(150) // 10 * 150 * 0.7 = 1050
        await wavax.mint(alice.address, wavaxMargin)
        await addMargin(alice, wavaxMargin, wavax, 1)
        // add margin for bob
        await wavax.mint(bob.address, wavaxMargin)
        await addMargin(bob, wavaxMargin, wavax, 1)
    })

    it('alice places order', async function() {
        shortOrder = {
            ammIndex: ZERO,
            trader: alice.address,
            baseAssetQuantity: ethers.utils.parseEther('-5'),
            price: ethers.utils.parseUnits('1000', 6),
            salt: BigNumber.from(Date.now()),
            reduceOnly: false
        }
        order1Hash = await orderBook.getOrderHash(shortOrder)

        await expect(orderBook.placeOrder(shortOrder)).to.revertedWith('OB_sender_is_not_trader')
        const tx = await orderBook.connect(alice).placeOrder(shortOrder)
        const _timestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp
        await expect(tx).to.emit(orderBook, "OrderPlaced").withArgs(
            shortOrder.trader,
            order1Hash,
            Object.values(shortOrder),
            _timestamp
        )
        await expect(orderBook.connect(alice).placeOrder(shortOrder)).to.revertedWith('OB_Order_already_exists')
        expect((await orderBook.orderInfo(order1Hash)).status).to.eq(1) // placed
    })

    it('ch.openPosition fails for long order', async function() {
      // long order with same price and baseAssetQuantity
        longOrder = {
            ammIndex: ZERO,
            trader: bob.address,
            baseAssetQuantity: ethers.utils.parseEther('5'),
            price: ethers.utils.parseUnits('1000', 6),
            salt: BigNumber.from(Date.now()),
            reduceOnly: false
        }
        order2Hash = await orderBook.getOrderHash(longOrder)
        await orderBook.connect(bob).placeOrder(longOrder)
        // reduce oracle price so that margin falls below minimum margin
        await oracle.setUnderlyingPrice(wavax.address, _1e6.mul(5))

        const tx = await orderBook.executeMatchedOrders([longOrder, shortOrder], longOrder.baseAssetQuantity)

        await expect(tx).to.emit(orderBook, 'OrderMatchingError')
        const event = await filterEvent(tx, 'OrderMatchingError')
        expect(event.args.orderHash).to.eq(order2Hash)
        expect(event.args.err).to.eq('CH: Below Minimum Allowable Margin')
        await assertPosSize(0, 0)
    })

    it('ch.openPosition fails for short order', async function() {
        // now bob deposits enough margin so that open position for them doesn't fail
        await addMargin(bob, _1e6.mul(4000))
        const tx = await orderBook.executeMatchedOrders([longOrder, shortOrder], longOrder.baseAssetQuantity)

        await expect(tx).to.emit(orderBook, 'OrderMatchingError')
        const event = await filterEvent(tx, 'OrderMatchingError')
        expect(event.args.orderHash).to.eq(order1Hash)
        expect(event.args.err).to.eq('CH: Below Minimum Allowable Margin')
        await assertPosSize(0, 0)
    })

    it('AMM.price_GT_bound', async function() {
        await oracle.setUnderlyingPrice(wavax.address, initialAvaxPrice * 4) // increase margin so that it doesnt revert for that reason

        const badShortOrder = JSON.parse(JSON.stringify(shortOrder))
        badShortOrder.price = ethers.utils.parseUnits('2000', 6)
        await orderBook.connect(alice).placeOrder(badShortOrder)

        const badLongOrder = JSON.parse(JSON.stringify(longOrder))
        badLongOrder.price = ethers.utils.parseUnits('2000', 6)
        await orderBook.connect(bob).placeOrder(badLongOrder)

        await expect(orderBook.executeMatchedOrders(
            [badLongOrder, badShortOrder],
            longOrder.baseAssetQuantity
        )).to.be.revertedWith('AMM.price_GT_bound')
        await assertPosSize(0, 0)
    })

    it('AMM.price_LT_bound', async function() {
        await oracle.setUnderlyingPrice(wavax.address, initialAvaxPrice * 4) // increase margin so that it doesnt revert for that reason

        const badShortOrder = JSON.parse(JSON.stringify(shortOrder))
        badShortOrder.price = ethers.utils.parseUnits('799', 6)
        await orderBook.connect(alice).placeOrder(badShortOrder)

        const badLongOrder = JSON.parse(JSON.stringify(longOrder))
        badLongOrder.price = ethers.utils.parseUnits('799', 6)
        await orderBook.connect(bob).placeOrder(badLongOrder)

        await expect(orderBook.executeMatchedOrders(
            [badLongOrder, badShortOrder],
            longOrder.baseAssetQuantity
        )).to.be.revertedWith('AMM.price_LT_bound')
        await assertPosSize(0, 0)
    })

    it('generic errors are not caught and bubbled up', async function() {
        await expect(
            orderBook.executeMatchedOrders([longOrder, shortOrder], 0)
        ).to.be.revertedWith('OB.not_multiple')

        // provide another reason to revert
        await clearingHouse.setMarginAccount('0x0000000000000000000000000000000000000000')
        await expect(orderBook.executeMatchedOrders(
            [longOrder, shortOrder],
            longOrder.baseAssetQuantity
        )).to.be.revertedWith('without a reason string')

        await clearingHouse.setMarginAccount(marginAccount.address) // reset
        await assertPosSize(0, 0)
    })

    it('orders match when conditions are met', async function() {
        const tx = await orderBook.executeMatchedOrders(
            [longOrder, shortOrder],
            longOrder.baseAssetQuantity
        )

        const _timestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp
        await expect(tx).to.emit(orderBook, 'OrdersMatched').withArgs(
            order2Hash,
            order1Hash,
            longOrder.baseAssetQuantity,
            longOrder.price,
            longOrder.baseAssetQuantity.mul(2),
            governance,
            _timestamp
        )

        expect((await orderBook.orderInfo(order1Hash)).status).to.eq(2) // filled
        expect((await orderBook.orderInfo(order2Hash)).status).to.eq(2) // filled

        const { alicePos, bobPos } = await assertPosSize(shortOrder.baseAssetQuantity, longOrder.baseAssetQuantity)

        const netQuote = longOrder.baseAssetQuantity.mul(longOrder.price).div(_1e18)
        expect(alicePos.openNotional).to.eq(netQuote)
        expect(bobPos.openNotional).to.eq(netQuote)
    })

    it('ch.liquidateSingleAmm fails', async function() {
        const { size } = await amm.positions(alice.address)
        charlie = signers[7]
        markPrice = _1e6.mul(1180)
        // set avax price to initial price
        const wavaxMargin = _1e18.mul(200)
        await oracle.setUnderlyingPrice(wavax.address, initialAvaxPrice)
        await wavax.mint(charlie.address, wavaxMargin)
        await addMargin(charlie, wavaxMargin, wavax, 1)
        ;({ order, orderHash } = await placeOrder(size, markPrice, charlie))

        // liquidate
        toLiquidate = size.mul(25e4).div(1e6) // 1/4th position liquidated
        let tx = await orderBook.liquidateAndExecuteOrder(alice.address, order, toLiquidate.abs())

        await expect(tx).to.emit(orderBook, 'LiquidationError').withArgs(
            alice.address,
            ethers.utils.solidityKeccak256(['string'], ['LIQUIDATION_FAILED']),
            'CH: Above Maintenance Margin',
            toLiquidate.abs()
        )
        await assertPosSize(shortOrder.baseAssetQuantity, longOrder.baseAssetQuantity)
    })

    it('ch.liquidateSingleAmm fails - revert from amm', async function() {
        // force alice in liquidation zone
        await placeAndExecuteTrade(longOrder.baseAssetQuantity, markPrice)
        await oracle.setUnderlyingPrice(weth.address, markPrice)
        expect(await clearingHouse.isAboveMaintenanceMargin(alice.address)).to.eq(false)

        let tx = await orderBook.liquidateAndExecuteOrder(alice.address, order, toLiquidate.mul(2).abs())
        await expect(tx).to.emit(orderBook, 'LiquidationError').withArgs(
            alice.address,
            ethers.utils.solidityKeccak256(['string'], ['LIQUIDATION_FAILED']),
            'AMM_liquidating_too_much_at_once',
            toLiquidate.mul(2).abs()
        )
        await assertPosSize(shortOrder.baseAssetQuantity, longOrder.baseAssetQuantity)
    })

    it('ch.openPosition fails in liquidation', async function() {
        await oracle.setUnderlyingPrice(wavax.address, initialAvaxPrice / 10)
        let tx = await orderBook.liquidateAndExecuteOrder(alice.address, order, toLiquidate.abs())
        await expect(tx).to.emit(orderBook, 'LiquidationError').withArgs(
            alice.address,
            orderHash,
            'OrderMatchingError',
            toLiquidate.abs()
        )

        await expect(tx).to.emit(orderBook, 'OrderMatchingError').withArgs(
            orderHash,
            'CH: Below Minimum Allowable Margin'
        )
        await assertPosSize(shortOrder.baseAssetQuantity, longOrder.baseAssetQuantity)
    })

    it('generic errors are not caught and bubbled up', async function() {
        await clearingHouse.setMarginAccount('0x0000000000000000000000000000000000000000')
        await expect(orderBook.liquidateAndExecuteOrder(
            alice.address, order, toLiquidate.abs())
        ).to.be.revertedWith('without a reason string')

        await clearingHouse.setMarginAccount(marginAccount.address)
        await assertPosSize(shortOrder.baseAssetQuantity, longOrder.baseAssetQuantity)
        const charliePos = await hubbleViewer.userPositions(charlie.address)
        expect(charliePos[0].size).to.eq(0)
    })

    it('liquidations will fail when toLiquidate=0', async function() {
        await addMargin(charlie, _1e6.mul(2000))
        await expect(orderBook.liquidateAndExecuteOrder(
            alice.address, order, 0)
        ).to.be.revertedWith('OB.not_multiple')
    })

    it('liquidations when all conditions met', async function() {
        let tx = await orderBook.liquidateAndExecuteOrder(alice.address, order, toLiquidate.abs())
        const _timestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp
        await expect(tx).to.emit(orderBook, 'LiquidationOrderMatched').withArgs(
            alice.address,
            orderHash,
            toLiquidate.abs(),
            order.price,
            longOrder.baseAssetQuantity.mul(4),
            governance,
            _timestamp
        )
        await assertPosSize(shortOrder.baseAssetQuantity.sub(toLiquidate), longOrder.baseAssetQuantity)
        const charliePos = await hubbleViewer.userPositions(charlie.address)
        expect(charliePos[0].size).to.eq(toLiquidate)
    })
})

async function assertPosSize(s1, s2) {
    const [ [alicePos], [bobPos] ] = await Promise.all([
        hubbleViewer.userPositions(alice.address),
        hubbleViewer.userPositions(bob.address)
    ])
    expect(alicePos.size).to.eq(s1)
    expect(bobPos.size).to.eq(s2)
    return { alicePos, bobPos }
}

async function placeAndExecuteTrade(size, price) {
        const signer1 = signers[9]
        const signer2 = signers[8]
        await addMargin(signer1, _1e6.mul(_1e6))
        await addMargin(signer2, _1e6.mul(_1e6))

        const { order: order1, orderHash: order1Hash } = await placeOrder(size, price, signer1)
        const { order: order2, orderHash: order2Hash } = await placeOrder(size.mul(-1), price, signer2)

        await orderBook.executeMatchedOrders([order1, order2], size.abs())
        // await orderBook.executeMatchedOrders(order1Hash, order2Hash, size.abs())
}

async function placeOrder(size, price, signer) {
    if (!signer) {
        signer = signers[9]
        await addMargin(signer, _1e6.mul(_1e6))
    }

    const order = {
        ammIndex: ZERO,
        trader: signer.address,
        baseAssetQuantity: size,
        price: price,
        salt: BigNumber.from(Date.now()),
        reduceOnly: false
    }

    await orderBook.connect(signer).placeOrder(order)
    const orderHash = await orderBook.getOrderHash(order)

    return { order, orderHash }
}

async function getDomain() {
    return {
        name: 'Hubble',
        version: '2.0',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: orderBook.address
    }
}
