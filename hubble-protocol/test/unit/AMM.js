const { expect } = require('chai');
const { BigNumber } = require('ethers')
const utils = require('../utils')

const {
    constants: { _1e6, _1e12, _1e18, ZERO },
    assertions,
    setupContracts,
    addMargin,
    gotoNextFundingTime,
    setupRestrictedTestToken,
} = utils

const TRADE_FEE = 0.000567 * _1e6

describe('Twap Price Tests', function() {
    /*
        Test data
        spot price (scaled by 6 demicals)
            1000000000
            999900000
            999700000
            1000000000
            999600000
            999100000
            999700000
            999000000
            998200000
            999100000
            998100000
            997000000
            998200000
            996900000
            995500000
            997000000
            995400000
            993700000
            995500000
            993600000
            991600000
            993700000
            991500000
            989200000
            991600000
            989100000
            986500000
            989200000
            986400000
            983500000
    */

    before(async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ amm, oracle, clearingHouse, weth } = await setupContracts({ tradeFee: TRADE_FEE }))
        // add margin
        margin = _1e6.mul(20000)
        await addMargin(signers[0], margin)

        oracleTwap = _1e6.mul(999)
        await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

        baseAssetQuantity = _1e18.mul(5)
        timestamp = parseInt(await amm.nextFundingTime())
        await gotoNextFundingTime(amm) // for deterministic twap calculation
    })

    it('return oracle twap when no trades', async () => {
        const twap = await amm.getMarkPriceTwap()
        expect(twap).to.eq(0)
    })

    it('get TWAP price', async () => {
        // generate sample data
        for (let i = 0; i < 30; i++) {
            if (i % 3 == 0) {
                let markPrice = await amm.lastPrice();
                markPrice = markPrice.add(_1e6.mul(i).div(10))
                const base = baseAssetQuantity.mul(2)

                await clearingHouse.openPosition3(0, base, markPrice)
                timestamp += 14
                await increaseEvmTime(timestamp)
            } else {
                let markPrice = await amm.lastPrice();
                markPrice = markPrice.sub(_1e6.mul(i).div(10))
                const base = baseAssetQuantity.mul(-1)

                await clearingHouse.openPosition3(0, base, markPrice)
                timestamp += 28
                await increaseEvmTime(timestamp)
            }
        }
        /**
        * total time interval = 3600 seconds
        * time interval where trades happened = 14*10 + 28*19 = 672 seconds
        * time interval where no trades happened = 3600 - 672 = 2928 seconds
        (
            (1000000000+1000000000+999700000+999100000+998200000+997000000+995500000+993700000+991600000+989200000)*14 +
            (999900000+999700000+999600000+999100000+999000000+998200000+998100000+997000000+996900000+995500000+995400000+993700000+993600000+991600000+991500000+989200000+989100000+986500000+986400000)*28 +
            983500000 * 2928
        ) / 3600 = 985662222 (scaled by 6 decimals)
        */

        timestamp += 3600 // calculate twap for last hour
        await increaseEvmTime(timestamp)
        await clearingHouse.updatePositions(alice) // dummy tx to set evm time

        expect(await amm.getMarkPriceTwap()).to.eq(985662222)
    })

    it('return the last hour twap even if there are trades in current hour', async () => {
        markPrice = _1e6.mul(1100)
        for (let i = 0; i < 10; i++) {
            await clearingHouse.openPosition3(0, baseAssetQuantity, markPrice)
            timestamp += 14
            await increaseEvmTime(timestamp)
        }
        expect(await amm.getMarkPriceTwap()).to.eq(985662222)
    })

    it('return last trade price if there is no trade in last hour', async () => {
        timestamp += 7200
        await increaseEvmTime(timestamp)
        await clearingHouse.updatePositions(alice) // dummy tx to set evm time

        expect(await amm.getMarkPriceTwap()).to.eq(markPrice)
    })
})

describe('AMM unit tests', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ alice ] = signers.map(s => s.address))
        bob = signers[1]

        initialPrice = _1e6.mul(1000)
        contracts = await setupContracts({ amm: { whitelist: false, initialPrice }})
        ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, hubbleViewer, liquidationPriceViewer, orderBook, oracle } = contracts)

        // add margin
        margin = _1e6.mul(2000)
        await addMargin(signers[0], margin)
        // set min size to 0.5
        await amm.setMinSizeRequirement(_1e18.div(2))
    })

    it('storage slots are as expected', async () => {
        // Test fixed slot for maxOracleSpreadRatio
        const VAR_MAX_ORACLE_SPREAD_RATIO_SLOT = 7
        storage = await ethers.provider.getStorageAt(
            amm.address,
            ethers.utils.solidityPack(['uint256'], [VAR_MAX_ORACLE_SPREAD_RATIO_SLOT])
        )
        maxOracleSpreadRatio = await amm.maxOracleSpreadRatio()
        expect(BigNumber.from(storage)).to.eq(maxOracleSpreadRatio)

        // Test fixed slot for maxLiquidationRatio
        const VAR_MAX_LIQUIDATION_RATIO_SLOT = 8
        storage = await ethers.provider.getStorageAt(
            amm.address,
            ethers.utils.solidityPack(['uint256'], [VAR_MAX_LIQUIDATION_RATIO_SLOT])
        )
        maxLiquidationRatio = await amm.maxLiquidationRatio()
        expect(BigNumber.from(storage)).to.eq(maxLiquidationRatio)

        // Test fixed slot for minSizeRequirement
        const VAR_MIN_SIZE_REQUIREMENT_SLOT = 9
        storage = await ethers.provider.getStorageAt(
            amm.address,
            ethers.utils.solidityPack(['uint256'], [VAR_MIN_SIZE_REQUIREMENT_SLOT])
        )
        minSizeRequirement = await amm.minSizeRequirement()
        expect(BigNumber.from(storage)).to.eq(minSizeRequirement)

        const ORACLE_SLOT = 10
        storage = await ethers.provider.getStorageAt(
            amm.address,
            ethers.utils.solidityPack(['uint256'], [ORACLE_SLOT])
        )
        expect(oracle.address).to.eq(ethers.utils.getAddress('0x' + storage.slice(26)))

        const UNDERLYING_ASSET_SLOT = 11
        storage = await ethers.provider.getStorageAt(
            amm.address,
            ethers.utils.solidityPack(['uint256'], [UNDERLYING_ASSET_SLOT])
        )
        expect(weth.address).to.eq(ethers.utils.getAddress('0x' + storage.slice(26)))

        const TEST_ORACLE_PRICES_MAPPING_SLOT = 53
        storage = await ethers.provider.getStorageAt(
            oracle.address,
            ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'uint256'], ['0x' + '0'.repeat(24) + weth.address.slice(2), TEST_ORACLE_PRICES_MAPPING_SLOT]))
        )
        expect(initialPrice).to.eq(BigNumber.from(storage))
    })

    it('openPosition fails when amm not whitelisted', async () => {
        // CH doesn't know about the AMM yet
        await expect(
            clearingHouse.openPosition2(0, -1, 0)
        ).to.be.revertedWith('Array accessed at an out-of-bounds or negative index')
    })

    it('whitelist amm', async () => {
        expect(await clearingHouse.getAmmsLength()).to.eq(0)
        let markets = await hubbleViewer.markets()
        expect(markets.length).to.eq(0)

        await clearingHouse.whitelistAmm(amm.address)

        expect(await clearingHouse.getAmmsLength()).to.eq(1)
        markets = await hubbleViewer.markets()
        expect(markets.length).to.eq(1)
        expect(markets[0].amm).to.eq(amm.address)
        expect(markets[0].underlying).to.eq(weth.address)
    })

    it('openPosition work when amm whitelisted', async () => {
        // make trade in next funding hour for deterministic funding rate
        await utils.gotoNextFundingTime(amm)
        await clearingHouse.settleFunding()

        const baseAssetQuantity = _1e18.mul(-1)
        await clearingHouse.openPosition2(0, _1e18.mul(-1), 0)
        const notionalPosition = baseAssetQuantity.mul(initialPrice).div(_1e18).abs()
        await assertions(contracts, alice, {
            size: baseAssetQuantity,
            openNotional: notionalPosition,
            notionalPosition,
            unrealizedPnl: ZERO
        })
    })

    it('add 2nd amm', async () => {
        avax = await utils.setupRestrictedTestToken('avax', 'avax', 6)
        ;({ amm: avaxAmm } = await utils.setupAmm(
            alice,
            [ 'AVAX-PERP', avax.address, oracle.address ],
            {
                initialRate: 65,
                whitelist: false,
                minSize: _1e18
            }
        ))
        // assert that AMM hasn't been whitelisted as yet
        expect(await clearingHouse.getAmmsLength()).to.eq(1)
        expect(await avaxAmm.minSizeRequirement()).to.eq(_1e18)
    })

    it('other amms will work as usual when 1 amm is not whitelisted', async () => {
        await oracle.setUnderlyingTwapPrice(weth.address, _1e6.mul(900))
        await utils.gotoNextFundingTime(amm)

        await ops()

        expect((await amm.cumulativePremiumFraction()).gt(0)).to.be.true
        expect(await avaxAmm.cumulativePremiumFraction()).to.eq(0)
    })

    it('other amms will work as usual when last amm is whitelisted', async () => {
        await clearingHouse.whitelistAmm(avaxAmm.address)
        await utils.gotoNextFundingTime(avaxAmm)

        // settleFunding will succeed even when there's no trade; premiumFraction will be ZERO
        await clearingHouse.settleFunding()

        expect(await avaxAmm.cumulativePremiumFraction()).to.eq(ZERO)

        // opening small positions will fail
        await expect(
            clearingHouse.connect(bob).openPosition2(0, _1e18.div(-10), 0)
        ).to.be.revertedWith('position_less_than_minSize')
        await expect(
            clearingHouse.connect(bob).openPosition2(0, _1e18.div(10), 0)
        ).to.be.revertedWith('position_less_than_minSize')
        await clearingHouse.openPosition2(1, _1e18.add(1), 0)

        await ops()
    })

    it('min size requirement', async () => {
        await clearingHouse.closePosition(0, 0)

        let posSize = _1e18.mul(-5)
        await clearingHouse.openPosition2(0, posSize, 0)
        // net position = -0.4
        posSize = _1e18.mul(46).div(10)
        await expect(clearingHouse.openPosition2(0, posSize, 0)).to.be.revertedWith('position_less_than_minSize')
        // net position = 0.3
        posSize = _1e18.mul(53).div(10)
        await expect(clearingHouse.openPosition2(0, posSize, 0)).to.be.revertedWith('position_less_than_minSize')
    })

    async function ops() {
        return Promise.all([
            clearingHouse.settleFunding(),
            clearingHouse.updatePositions(alice),
            clearingHouse.openPosition2(0, _1e18.mul(-1), 0)
        ])
    }
})

describe('Oracle Price Spread Check', async function() {
    beforeEach(async function() {
        signers = await ethers.getSigners()
        ;([ alice ] = signers.map(s => s.address))
        bob = signers[1]

        contracts = await setupContracts({ tradeFee: TRADE_FEE, amm: { testAmm: true }})
        ;({ marginAccount, oracle, clearingHouse, amm, vusd, weth, swap, hubbleViewer } = contracts)

        // addCollateral, using a different collateral to make a trader liquidable easily
        avax = await setupRestrictedTestToken('AVAX', 'AVAX', 6)
        avaxOraclePrice = 1e6 * 100 // $100
        await Promise.all([
            oracle.setUnderlyingPrice(avax.address, avaxOraclePrice),
            marginAccount.whitelistCollateral(avax.address, 0.8 * 1e6) // weight = 0.8
        ])

        // addMargin
        avaxMargin = _1e6.mul(20) // $2000
        await Promise.all([
            avax.mint(alice, avaxMargin),
            avax.approve(marginAccount.address, avaxMargin),
        ])
        await marginAccount.addMargin(1, avaxMargin)

        // set markPrice
        await clearingHouse.openPosition2(0, _1e18.mul(-1), 0)
    })

    it('price decrease not allowed when markPrice is below price spread', async function() {
        // markPrice = 1000, indexPrice = 1000/0.8 = 1250
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1250))
        // await expect(
        //     clearingHouse.openPosition2(0, _1e18.mul(-5), _1e6.mul(4999)) // price = 4999 / 5 = 999.8
        // ).to.be.revertedWith('AMM.price_LT_bound')

        // longs allowed
        await clearingHouse.openPosition2(0, _1e18.mul(5), _1e6.mul(5000))
    })

    it('price increase not allowed when markPrice is above price spread', async function() {
        // markPrice = 1000, indexPrice = 1000/1.2 = 833
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(833))
        // await expect(
        //     clearingHouse.openPosition2(0, _1e18.mul(5), ethers.constants.MaxUint256)
        // ).to.be.revertedWith('AMM.price_GT_bound')
    })

    // marginFraction < maintenanceMargin < minAllowableMargin < oracleBasedMF
    it('amm isOverSpreadLimit on long side', async function() {
        await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)

        // bob makes counter-trade to drastically reduce amm based marginFraction
        avaxMargin = _1e6.mul(2000)
        await Promise.all([
            avax.mint(bob.address, avaxMargin),
            avax.connect(bob).approve(marginAccount.address, avaxMargin),
        ])
        await marginAccount.connect(bob).addMargin(1, avaxMargin)
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1100))
        await clearingHouse.connect(bob).openPosition2(0, _1e18.mul(120), _1e6.mul(144000)) // price = 1200

        // Get amm over spread limit
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(700))

        // evaluate both MFs independently from the AMM
        const margin = await marginAccount.getNormalizedMargin(alice) // avaxMargin * avaxOraclePrice * .8 - tradeFee and no funding payments
        ;([
            { unrealizedPnl, notionalPosition },
            { marginFraction: oracleBasedMF },
            minAllowableMargin,
            maintenanceMargin,
        ] = await Promise.all([
            amm.getNotionalPositionAndUnrealizedPnl(alice),
            amm.getOracleBasedMarginFraction(alice, margin),
            clearingHouse.minAllowableMargin(),
            clearingHouse.maintenanceMargin()
        ]))
        const marginFraction = margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition)

        // asserting that we have indeed created the conditions we are testing in this test case
        expect(marginFraction.lt(maintenanceMargin)).to.be.true
        expect(maintenanceMargin.lt(minAllowableMargin)).to.be.true
        expect(minAllowableMargin.lt(oracleBasedMF)).to.be.true

        // then assert that clearingHouse has indeed to oracle based pricing for liquidations but marginFraction for trades
        expect(
            await clearingHouse.calcMarginFraction(alice, true, 0)
        ).to.eq(oracleBasedMF)
        expect(
            await clearingHouse.calcMarginFraction(alice, true, 1)
        ).to.eq(marginFraction)

        // cannot make a trade
        await expect(
            clearingHouse.assertMarginRequirement(alice)
        ).to.be.revertedWith('CH: Below Minimum Allowable Margin')

        // However, when it comes to liquidation, oracle based pricing will kick in again
        expect(await clearingHouse.calcMarginFraction(alice, false, 0 /* Maintenance_Margin */)).to.eq(oracleBasedMF)
        await expect(
            clearingHouse.liquidate2(alice)
        ).to.be.revertedWith('CH: Above Maintenance Margin')

        // Finally, trader will be liquidable once both MFs are < maintenanceMargin
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1500))
        ;({ marginFraction: oracleBasedMF } = await amm.getOracleBasedMarginFraction(alice, margin))
        expect(oracleBasedMF.lt(maintenanceMargin)).to.be.true
        await clearingHouse.liquidate2(alice)
    })

    // we will assert that oracle based pricing kicks in when lastPrice = ~998, indexPrice = 1300
    // oracleBasedMF < maintenanceMargin < minAllowableMargin < marginFraction
    it('amm isOverSpreadLimit on short side', async function() {
        await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)

        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1300))

        // evaluate both MFs independently from the AMM
        let margin = await marginAccount.getNormalizedMargin(alice) // avaxMargin * avaxOraclePrice * .8 - tradeFee and no funding payments
        ;([
            { unrealizedPnl, notionalPosition },
            { marginFraction: oracleBasedMF },
            minAllowableMargin,
            maintenanceMargin,
        ] = await Promise.all([
            amm.getNotionalPositionAndUnrealizedPnl(alice),
            amm.getOracleBasedMarginFraction(alice, margin),
            clearingHouse.minAllowableMargin(),
            clearingHouse.maintenanceMargin()
        ]))
        let marginFraction = margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition)

        // asserting that we have indeed created the conditions we are testing in this test case
        expect(oracleBasedMF.lt(maintenanceMargin)).to.be.true
        expect(maintenanceMargin.lt(minAllowableMargin)).to.be.true
        expect(minAllowableMargin.lt(marginFraction)).to.be.true // trade would be allowed based on amm alone

        // then assert that clearingHouse has indeed to oracle based pricing for trades but marginFraction for liquidations
        expect(
            await clearingHouse.calcMarginFraction(alice, true, 0)
        ).to.eq(marginFraction)
        expect(
            await clearingHouse.calcMarginFraction(alice, true, 1)
        ).to.eq(oracleBasedMF)

        // cannot make a trade
        await expect(
            clearingHouse.assertMarginRequirement(alice)
        ).to.be.revertedWith('CH: Below Minimum Allowable Margin')

        // can reduce position however (doesn't revert)
        await clearingHouse.callStatic.closePosition(0, _1e6.mul(1300)) // at same price as underlying

        // However, when it comes to liquidation, amm based marginFraction will kick in again
        expect(await clearingHouse.calcMarginFraction(alice, false, 0 /* Maintenance_Margin */)).to.eq(marginFraction)
        await expect(
            clearingHouse.liquidate2(alice)
        ).to.be.revertedWith('CH: Above Maintenance Margin')

        // Finally, trader will be liquidable once both MFs are < maintenanceMargin
        // dropping collateral price to make amm based MF fall below maintenanceMargin
        await oracle.setUnderlyingPrice(avax.address, _1e6.mul(30))
        margin = await marginAccount.getNormalizedMargin(alice)
        ;([
            { unrealizedPnl, notionalPosition },
            { marginFraction: oracleBasedMF }
        ] = await Promise.all([
            amm.getNotionalPositionAndUnrealizedPnl(alice),
            amm.getOracleBasedMarginFraction(alice, margin)
        ]))
        marginFraction = margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition)
        // oracleBasedMF < marginFraction < maintenanceMargin
        expect(oracleBasedMF.lt(marginFraction)).to.be.true
        expect(marginFraction.lt(maintenanceMargin)).to.be.true

        await clearingHouse.liquidate2(alice)
    })
})

async function increaseEvmTime(timeInSeconds) {
    await network.provider.send('evm_setNextBlockTimestamp', [timeInSeconds]);
}
