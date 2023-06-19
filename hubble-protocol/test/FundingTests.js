const { expect } = require('chai')

const {
    getTradeDetails,
    assertions,
    gotoNextFundingTime,
    setupContracts,
    parseRawEvent,
    addMargin,
    constants: { _1e6, _1e18, ZERO, feeSink }
} = require('./utils')

describe('Funding Tests', function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2 ] = signers)
        alice = signers[0].address
    })

    describe('single trader', async function() {
        beforeEach(async function() {
            contracts = await setupContracts()
            ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, hubbleViewer } = contracts)
            initialRate = _1e6.mul(1000)

            // add margin
            margin = _1e6.mul(2000)
            await addMargin(signers[0], margin)

            // don't cap funding rate
            await amm.setFundingParams(3600, 900, 0, 3600)
        })

        it('alice shorts and receives +ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            const shortPrice = _1e6.mul(980)
            let tx = await clearingHouse.openPosition3(0 /* amm index */, baseAssetQuantity, shortPrice)
            ;({ quoteAsset, fee } = await getTradeDetails(tx))
            const tradeTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            // underlying
            const oracleTwap = _1e6.mul(900)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            await gotoNextFundingTime(amm)
            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            // mark price
            const twap = shortPrice.mul(fundingTimestamp - tradeTimestamp).div(3600)
            expect(twap).to.eq(await amm.getMarkPriceTwap())
            const premiumFraction = await amm.cumulativePremiumFraction()
            expect(premiumFraction).to.eq(twap.sub(oracleTwap).div(24))

            await clearingHouse.updatePositions(alice)

            let fundingReceived = premiumFraction.mul(baseAssetQuantity.mul(-1)).div(_1e18)
            const remainingMargin = margin.add(fundingReceived).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: remainingMargin
            })

            const { totalCollateral, freeMargin } = await hubbleViewer.getAccountInfo(alice)
            const minAllowableMargin = await clearingHouse.minAllowableMargin()
            expect(totalCollateral).to.eq(remainingMargin)

            // free_margin = remainingMargin + min(oracle_pnl, mark_pnl) - notionalPosition/minAllowableMargin
            // mark_pnl = 0 because no trades after the initial trade
            const oracle_np = initialRate.mul(baseAssetQuantity.abs()).div(_1e18)
            const oracle_pnl = quoteAsset.sub(oracle_np)
            expect(freeMargin).to.eq(remainingMargin.add(oracle_pnl).sub(oracle_np.mul(minAllowableMargin).div(_1e6)))
        })

        it('alice shorts and pays -ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            const price = _1e6.mul(995)
            let tx = await clearingHouse.openPosition3(0 /* amm index */, baseAssetQuantity, price)
            ;({ quoteAsset, fee } = await getTradeDetails(tx))
            const tradeTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const oracleTwap = _1e6.mul(1100)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            await gotoNextFundingTime(amm)
            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const twap = price.mul(fundingTimestamp - tradeTimestamp).div(3600)
            expect(twap).to.eq(await amm.getMarkPriceTwap())
            const premiumFraction = await amm.cumulativePremiumFraction()
            expect(premiumFraction).to.eq(twap.sub(oracleTwap).div(24))

            await clearingHouse.updatePositions(alice)

            const fundingPaid = premiumFraction.mul(baseAssetQuantity).div(_1e18)
            const remainingMargin = margin.sub(fundingPaid).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: remainingMargin
            })
        })

        it('alice longs and pays +ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            const price = _1e6.mul(1020)
            let tx = await clearingHouse.openPosition3(0 /* amm index */, baseAssetQuantity, price)
            ;({ quoteAsset, fee } = await getTradeDetails(tx))
            const tradeTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const oracleTwap = _1e6.mul(900)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            await gotoNextFundingTime(amm)
            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const twap = price.mul(fundingTimestamp - tradeTimestamp).div(3600)
            expect(twap).to.eq(await amm.getMarkPriceTwap())
            const premiumFraction = await amm.cumulativePremiumFraction()
            expect(premiumFraction).to.eq(twap.sub(oracleTwap).div(24))

            await clearingHouse.updatePositions(alice)

            const fundingPaid = premiumFraction.mul(baseAssetQuantity).div(_1e18)
            const remainingMargin = margin.sub(fundingPaid).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: remainingMargin
            })

            const { totalCollateral, freeMargin } = await hubbleViewer.getAccountInfo(alice)
            const minAllowableMargin = await clearingHouse.minAllowableMargin()
            expect(totalCollateral).to.eq(remainingMargin)

            // free_margin = remainingMargin + min(oracle_pnl, mark_pnl) - notionalPosition/minAllowableMargin
            // mark_pnl = 0 because no trades after the initial trade
            const oracle_np = initialRate.mul(baseAssetQuantity.abs()).div(_1e18)
            const oracle_pnl = oracle_np.sub(quoteAsset)
            expect(freeMargin).to.eq(remainingMargin.add(oracle_pnl).sub(oracle_np.mul(minAllowableMargin).div(_1e6)))
        })

        it('alice longs and receives -ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            const longPrice = _1e6.mul(1020)
            let tx = await clearingHouse.openPosition3(0 /* amm index */, baseAssetQuantity, longPrice)
            ;({ quoteAsset, fee } = await getTradeDetails(tx))
            const tradeTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const oracleTwap = _1e6.mul(1100)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            await gotoNextFundingTime(amm)
            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const twap = longPrice.mul(fundingTimestamp - tradeTimestamp).div(3600)
            expect(twap).to.eq(await amm.getMarkPriceTwap())
            const premiumFraction = await amm.cumulativePremiumFraction()
            expect(premiumFraction).to.eq(twap.sub(oracleTwap).div(24))

            await clearingHouse.updatePositions(alice)

            let fundingReceived = premiumFraction.mul(baseAssetQuantity).div(_1e18).mul(-1) // premiumFraction is -ve
            const remainingMargin = margin.add(fundingReceived).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: remainingMargin
            })
        })

        it('alice shorts and paying -ve funding causes them to drop below maintenance margin and liquidated', async function() {
            await amm.setPriceSpreadParams(await amm.maxOracleSpreadRatio(), 1e4)
            await amm.setLiquidationSizeRatio(1e6)

            const baseAssetQuantity = _1e18.mul(-5)
            const price = _1e6.mul(1000)
            let tx = await clearingHouse.openPosition3(0 /* amm index */, baseAssetQuantity, price)
            ;({ quoteAsset, fee } = await getTradeDetails(tx))
            const tradeTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            // $2k margin, ~$5k in notional position, < $500 margin will put them underwater => $300 funding/unit
            const oracleTwap = _1e6.mul(8200)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            await gotoNextFundingTime(amm)
            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const twap = price.mul(fundingTimestamp - tradeTimestamp).div(3600)
            expect(twap).to.eq(await amm.getMarkPriceTwap())
            const premiumFraction = await amm.cumulativePremiumFraction()
            expect(premiumFraction).to.eq(twap.sub(oracleTwap).div(24))

            await clearingHouse.updatePositions(alice)

            const fundingPaid = premiumFraction.mul(baseAssetQuantity).div(_1e18)
            let remainingMargin = margin.sub(fundingPaid).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: remainingMargin
            })

            // can\'t open new positions below maintenance margin
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
            await expect(
                clearingHouse.openPosition2(0, _1e18.mul(-1), 0)
            ).to.be.revertedWith('CH: Below Minimum Allowable Margin')

            // Liquidate
            const feeSinkBalance = await vusd.balanceOf(feeSink)
            ;({ unrealizedPnl, notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            await clearingHouse.connect(liquidator1).liquidate2(alice)

            const liquidationPenalty = notionalPosition.mul(5e4).div(_1e6)
            remainingMargin = remainingMargin.sub(liquidationPenalty).add(unrealizedPnl)

            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin) // entire margin is in vusd
            expect(await vusd.balanceOf(feeSink)).to.eq(liquidationPenalty.add(feeSinkBalance))
            await assertions(contracts, alice, {
                size: 0,
                openNotional: 0,
                notionalPosition: 0,
                unrealizedPnl: 0,
                margin: remainingMargin
            })
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
        })
    })

    it('alice is in liquidation zone but saved by positive funding payment', async () => {
        ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, insuranceFund } = await setupContracts())
        await gotoNextFundingTime(amm)
        await clearingHouse.settleFunding()

        await amm.setFundingParams(3600, 900, 0, 3600)
        await marginAccount.whitelistCollateral(weth.address, 0.7 * 1e6) // weight = 0.7
        wethAmount = _1e18.mul(2)
        await weth.mint(alice, wethAmount)
        await weth.approve(marginAccount.address, wethAmount)
        await marginAccount.addMargin(1, wethAmount);

        const baseAssetQuantity = _1e18.mul(-5)
        await clearingHouse.openPosition2(0 , baseAssetQuantity, 0)
        await gotoNextFundingTime(amm)

        // alice margin falls below maintenance margin
        const base = _1e18.mul(15)
        const price = _1e6.mul(1220)
        await oracle.setUnderlyingPrice(weth.address, price)
        await addMargin(bob, base.mul(price).div(_1e18))
        await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false

        // mine extra block to change block number
        await network.provider.send("evm_mine");
        await clearingHouse.connect(liquidator1).callStatic.liquidate2(alice) // doesn't throw exception

        // funding settled
        const oracleTwap = _1e6.mul(700)
        await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap) // +ve funding rate
        await clearingHouse.settleFunding()
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
        await expect(
            clearingHouse.connect(liquidator1).liquidate2(alice)
        ).to.be.revertedWith('Above Maintenance Margin')
    })

    describe('funding payment cap', async function() {
        before(async function() {
            contracts = await setupContracts()
            ;({ marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, hubbleViewer } = contracts)

            // add margin
            const margin = _1e6.mul(2000)
            await addMargin(signers[0], margin)
            // set maxFunding rate = 50% annual = 0.00570776% hourly
            maxFundingRate = 57
            await amm.setFundingParams(3600, 900, maxFundingRate, 3600)
            // start trading in next funding hour for deterministic mark price twap
            await gotoNextFundingTime(amm)
            await clearingHouse.settleFunding()
        })

        it('fundingRate positive and greater than maxFundingRate', async () => {
            // alice shorts
            baseAssetQuantity = _1e18.mul(-5)
            await clearingHouse.openPosition2(0, baseAssetQuantity, 0)
            await gotoNextFundingTime(amm)
            const oracleTwap = _1e6.mul(990)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
            const ammTwap = await amm.getMarkPriceTwap() // 999

            const tx = await clearingHouse.settleFunding()
            const premiumFraction = (await parseRawEvent(tx, clearingHouse, 'FundingRateUpdated')).args.premiumFraction

            expect(ammTwap.sub(oracleTwap).div(24)).to.gt(oracleTwap.mul(maxFundingRate).div(1e6))
            expect(premiumFraction).to.eq(oracleTwap.mul(maxFundingRate).div(1e6))

            const margin = await marginAccount.margin(0, alice)
            await clearingHouse.updatePositions(alice)

            let fundingReceived = premiumFraction.mul(baseAssetQuantity.abs()).div(_1e18)
            expect(await marginAccount.margin(0, alice)).to.eq(margin.add(fundingReceived))
        })

        it('fundingRate negative and less than -maxFundingRate', async () => {
            await gotoNextFundingTime(amm)
            const oracleTwap = _1e6.mul(1010)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
            const ammTwap = await amm.getMarkPriceTwap() // 999

            const tx = await clearingHouse.settleFunding()
            const premiumFraction = (await parseRawEvent(tx, clearingHouse, 'FundingRateUpdated')).args.premiumFraction

            expect(ammTwap.sub(oracleTwap).div(24)).to.lt(oracleTwap.mul(-maxFundingRate).div(1e6))
            expect(premiumFraction).to.eq(oracleTwap.mul(-maxFundingRate).div(1e6))

            const margin = await marginAccount.margin(0, alice)
            await clearingHouse.updatePositions(alice)

            const fundingPaid = premiumFraction.mul(baseAssetQuantity).div(_1e18)
            expect(await marginAccount.margin(0, alice)).to.eq(margin.sub(fundingPaid))
        })

        it('fundingRate positive and less than maxFundingRate', async () => {
            await gotoNextFundingTime(amm)
            const oracleTwap = _1e6.mul(999)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
            const ammTwap = await amm.getMarkPriceTwap() // 999

            const tx = await clearingHouse.settleFunding()
            const premiumFraction = (await parseRawEvent(tx, clearingHouse, 'FundingRateUpdated')).args.premiumFraction

            expect(ammTwap.sub(oracleTwap).div(24)).to.lt(oracleTwap.mul(maxFundingRate).div(1e6))
            expect(premiumFraction).to.eq(ammTwap.sub(oracleTwap).div(24))

            const margin = await marginAccount.margin(0, alice)
            await clearingHouse.updatePositions(alice)

            let fundingReceived = premiumFraction.mul(baseAssetQuantity.abs()).div(_1e18)
            expect(await marginAccount.margin(0, alice)).to.eq(margin.add(fundingReceived))
        })

        it('fundingRate negative and greater than -maxFundingRate', async () => {
            await gotoNextFundingTime(amm)
            const oracleTwap = _1e6.mul(1000)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
            const ammTwap = await amm.getMarkPriceTwap() // 999

            const tx = await clearingHouse.settleFunding()
            const premiumFraction = (await parseRawEvent(tx, clearingHouse, 'FundingRateUpdated')).args.premiumFraction

            expect(ammTwap.sub(oracleTwap).div(24)).to.gt(oracleTwap.mul(-maxFundingRate).div(1e6))
            expect(premiumFraction).to.eq(ammTwap.sub(oracleTwap).div(24))

            const margin = await marginAccount.margin(0, alice)
            await clearingHouse.updatePositions(alice)

            const fundingPaid = premiumFraction.mul(baseAssetQuantity).div(_1e18)
            expect(await marginAccount.margin(0, alice)).to.eq(margin.sub(fundingPaid))
        })
    })
})
