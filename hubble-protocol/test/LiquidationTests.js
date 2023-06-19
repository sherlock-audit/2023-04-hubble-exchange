const { expect } = require('chai');
const { BigNumber } = require('ethers')

const {
    constants: { _1e6, _1e18, ZERO, feeSink },
    getTradeDetails,
    setupContracts,
    setupRestrictedTestToken,
    filterEvent,
    addMargin,
    setDefaultClearingHouseParams
} = require('./utils')

describe('Liquidation Tests', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2, liquidator3, admin ] = signers)
        alice = signers[0].address
        ;({ orderBook, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, insuranceFund, hubbleViewer } = await setupContracts())

        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address) // will mint vusd to liquidators account
        await clearingHouse.setOrderBook(orderBook.address)
        await setDefaultClearingHouseParams(clearingHouse)
        await clearingHouse.setOrderBook(signers[0].address)
        await amm.setLiquidationSizeRatio(1e6)
        await amm.setPriceSpreadParams(await amm.maxOracleSpreadRatio(), 1e4)
    })

    it('addCollateral', async () => {
        oraclePrice = 1e6 * 1000 // $1k
        await oracle.setUnderlyingPrice(weth.address, oraclePrice)
        await marginAccount.whitelistCollateral(weth.address, 0.7 * 1e6) // weight = 0.7
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2)
    })

    it('addMargin', async () => {
        wethMargin = _1e18
        await weth.mint(alice, wethMargin)
        await weth.approve(marginAccount.address, wethMargin)

        // being lazy, adding a pausability test here
        await marginAccount.pause()
        await expect(
            marginAccount.addMargin(1, wethMargin)
        ).to.be.revertedWith('Pausable: paused')
        await marginAccount.unpause()

        await marginAccount.addMargin(1, wethMargin)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2)
    })

    it('alice makes a trade', async function() {
        // being lazy, adding a pausability test here
        await clearingHouse.pause()
        await expect(
            clearingHouse.openPosition2(0, _1e18.mul(-5), 0)
        ).to.be.revertedWith('Pausable: paused')
        await clearingHouse.unpause()

        let tx = await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)
        ;({ fee: tradeFee } = await getTradeDetails(tx))
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(1)

        const userInfo = await hubbleViewer.userInfo(alice)
        expect(userInfo[0]).to.eq(tradeFee.mul(-1)) // vUSD margin = 0 - tradeFee
        expect(userInfo[1]).to.eq(wethMargin)
    })

    it('bob makes a counter-trade', async function() {
        const base = _1e18.mul(15)
        oraclePrice = _1e6.mul(1100)
        await oracle.setUnderlyingPrice(weth.address, oraclePrice)
        await addMargin(bob, base.mul(oraclePrice).div(_1e18))
        await clearingHouse.connect(bob).openPosition2(0, base, base.mul(oraclePrice).div(_1e18))
    })

    it('alice\'s position is liquidated', async function() {
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(1)

        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        ;({ unrealizedPnl, notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(alice))

        const ifVusdBal = await vusd.balanceOf(insuranceFund.address)

        // being lazy, adding a pausability test here
        await clearingHouse.pause()
        await expect(
            clearingHouse.connect(liquidator1).liquidate2(alice)
        ).to.be.revertedWith('Pausable: paused')
        await clearingHouse.unpause()

        const feeSinkBalance = await vusd.balanceOf(feeSink)
        await clearingHouse.connect(liquidator1).liquidate2(alice)

        const liquidationPenalty = notionalPosition.mul(5e4).div(_1e6)
        expect(await marginAccount.margin(0, alice)).to.eq(
            unrealizedPnl.sub(liquidationPenalty).sub(tradeFee)
        )
        expect(await vusd.balanceOf(feeSink)).to.eq(liquidationPenalty.add(feeSinkBalance))
    })

    it('alice is in liquidation zone B', async function() {
        oraclePrice = _1e6.mul(900)
        await oracle.setUnderlyingPrice(weth.address, oraclePrice)
        const { weighted, spot } = await marginAccount.weightedAndSpotCollateral(alice)
        expect(weighted.lt(ZERO)).to.be.true
        expect(spot.gt(ZERO)).to.be.true
        ;({ _isLiquidatable, incentivePerDollar } = await marginAccount.isLiquidatable(alice, true))
        expect(incentivePerDollar.toNumber() / 1e6).to.eq(1.05)
        expect(_isLiquidatable).to.eq(0) // IS_LIQUIDATABLE
    })

    it('liquidateExactSeize (incentivePerDollar = 5%)', async function() {
        // the alice's debt is ~ -777, whereas 1 eth at weight = 0.7 and price = 1k allows for $700 margin
        const seizeAmount = _1e18.mul(2).div(10) // 0.2 ETH

        // .2 * 1000 / (1 + .05) = ~190
        const repayAmount = seizeAmount.mul(oraclePrice).div(_1e18).mul(_1e6).div(incentivePerDollar)
        await vusd.connect(admin).mint(liquidator2.address, repayAmount)
        await vusd.connect(liquidator2).approve(marginAccount.address, repayAmount)

        await marginAccount.connect(liquidator2).liquidateExactSeize(alice, ethers.constants.MaxUint256, 1, seizeAmount)
        expect(await weth.balanceOf(liquidator2.address)).to.eq(seizeAmount)
        expect(await vusd.balanceOf(liquidator2.address)).to.eq(ZERO)
    })

    it('liquidateFlexible (liquidateExactRepay branch, incentivePerDollar = 5%)', async function() {
        // the vusd margin is -606.x, whereas .8 eth at weight = 0.7 and price = 1k allows for $560 (= .8*.7*1000) margin
        const [
            { weighted, spot },
            { _isLiquidatable, repayAmount, incentivePerDollar },
            wethMargin
        ] = await Promise.all([
            marginAccount.weightedAndSpotCollateral(alice),
            marginAccount.isLiquidatable(alice, true),
            marginAccount.margin(1, alice)
        ])
        expect(parseInt(weighted.toNumber() / 1e6)).to.eq(-102) // .8 * 900 * .7 - 606.x
        expect(parseInt(spot.toNumber() / 1e6)).to.eq(113) // .8 * 900 - 606.x
        expect(_isLiquidatable).to.eq(0) // IS_LIQUIDATABLE
        expect(incentivePerDollar.toNumber() / 1e6).to.eq(1.05) // max incentive was (spot + repayAmount) / repayAmount

        await vusd.connect(admin).mint(liquidator3.address, repayAmount)
        await vusd.connect(liquidator3).approve(marginAccount.address, repayAmount)

        // liquidateExactRepay part of if-else is called
        await marginAccount.connect(liquidator3).liquidateFlexible(alice, ethers.constants.MaxUint256, [1])

        const seizeAmount = repayAmount.mul(incentivePerDollar).mul(_1e6.mul(_1e6)).div(oraclePrice) // 12 decimals for eth
        expect(await weth.balanceOf(liquidator3.address)).to.eq(seizeAmount)
        expect(await vusd.balanceOf(liquidator3.address)).to.eq(ZERO)
        expect(await marginAccount.margin(0, alice)).to.eq(ZERO)
        expect(await marginAccount.margin(1, alice)).to.eq(wethMargin.sub(seizeAmount))
    })

    it('alice is out of liquidation zone', async function() {
        const { weighted, spot } = await marginAccount.weightedAndSpotCollateral(alice)
        expect(weighted.gt(ZERO)).to.be.true
        expect(spot.gt(ZERO)).to.be.true
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2) // NO_DEBT
    })
})

describe('Multi-collateral Liquidation Tests', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2, liquidator3, admin, charlie ] = signers)
        alice = signers[0].address
        ;({ orderBook, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, insuranceFund } = await setupContracts())
        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address) // will mint vusd to liquidators account
        await clearingHouse.setOrderBook(orderBook.address)
        await setDefaultClearingHouseParams(clearingHouse)
        await clearingHouse.setOrderBook(signers[0].address)

        await amm.setLiquidationSizeRatio(1e6)
        await amm.setPriceSpreadParams(1e6, 1e6)

        // addCollateral
        avax = await setupRestrictedTestToken('AVAX', 'AVAX', 6)
        await avax.grantRole(ethers.utils.id('TRANSFER_ROLE'), insuranceFund.address)
        oraclePrice = 1e6 * 1000 // $1k
        avaxOraclePrice = 1e6 * 50 // $50
        await Promise.all([
            oracle.setUnderlyingPrice(weth.address, oraclePrice),
            oracle.setUnderlyingPrice(avax.address, avaxOraclePrice),
        ])
        await marginAccount.whitelistCollateral(weth.address, 0.7 * 1e6), // weight = 0.7
        await marginAccount.whitelistCollateral(avax.address, 0.8 * 1e6) // weight = 0.8
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2) // NO_DEBT

        // addMargin
        wethMargin = _1e18.div(4) // $250
        avaxMargin = _1e6.mul(15) // $750
        await Promise.all([
            weth.mint(alice, wethMargin),
            weth.approve(marginAccount.address, wethMargin),
            avax.mint(alice, avaxMargin),
            avax.approve(marginAccount.address, avaxMargin),
        ])
        await marginAccount.addMargin(1, wethMargin)
        await marginAccount.addMargin(2, avaxMargin)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2) // NO_DEBT

        // alice makes a trade
        let tx = await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)
        ;({ fee: tradeFee } = await getTradeDetails(tx))
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(1) // OPEN_POSITIONS

        // bob increases the price
        const base = _1e18.mul(15)
        const price = _1e6.mul(1130)
        await addMargin(bob, base.mul(price).div(_1e18))
        await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))

        // index also increases
        await oracle.setUnderlyingPrice(weth.address, price)
    })

    it('alice\'s position is liquidated', async function() {
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(1) // OPEN_POSITIONS

        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        ;({ unrealizedPnl, notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(alice))

        // unrealizedPnl = (1000 - 1130) * 5 = -650, notionalPosition = 5 * 1130 = 5650
        const feeSinkBalance = await vusd.balanceOf(feeSink)
        await clearingHouse.connect(liquidator1).liquidate2(alice)

        const liquidationPenalty = notionalPosition.mul(5e4).div(_1e6) // 5650 * .05 = 282.5
        expect(await marginAccount.margin(0, alice)).to.eq(
            unrealizedPnl.sub(liquidationPenalty).sub(tradeFee) // -650 - 282.5 - 2.5 = -935
        )
        expect(await vusd.balanceOf(feeSink)).to.eq(liquidationPenalty.add(feeSinkBalance))
    })

    it('alice is in liquidation zone B', async function() {
        const { weighted, spot } = await marginAccount.weightedAndSpotCollateral(alice)
        expect(weighted.lt(ZERO)).to.be.true
        expect(spot.gt(ZERO)).to.be.true
        ;({ _isLiquidatable, incentivePerDollar } = await marginAccount.isLiquidatable(alice, true))
        expect(_isLiquidatable).to.eq(0) // IS_LIQUIDATABLE
    })

    it('liquidateFlexible (_liquidateExactSeize branch, incentivePerDollar < 5%)', async function() {
        // the alice's debt is -935, margin = .25*1130*.7 + 15*50*.8 = $797.75, spot = .25*1130 + 15*50 = $1032.5
        const [
            { weighted, spot },
            { _isLiquidatable, repayAmount, incentivePerDollar },
            wethMargin
        ] = await Promise.all([
            marginAccount.weightedAndSpotCollateral(alice),
            marginAccount.isLiquidatable(alice, true),
            marginAccount.margin(1, alice)
        ])
        expect(weighted.toNumber() / 1e6).to.eq(-137.25) // 797.75 - 935
        expect(spot.toNumber() / 1e6).to.eq(97.5) // 1032.5 - 935
        expect(_isLiquidatable).to.eq(0) // IS_LIQUIDATABLE
        expect(incentivePerDollar.toNumber() / 1e6).to.eq(1.05) // min(1.05, 1000/935)

        await vusd.connect(admin).mint(liquidator3.address, repayAmount)
        await vusd.connect(liquidator3).approve(marginAccount.address, repayAmount)

        // _liquidateExactSeize part of if-else is called
        // will seize all eth and repay .25*1130/1.05 = 269.04 husd
        await marginAccount.connect(liquidator3).liquidateFlexible(alice, ethers.constants.MaxUint256, [1])

        expect(await weth.balanceOf(liquidator3.address)).to.eq(wethMargin)
        expect((await marginAccount.margin(0, alice)).lt(ZERO)).to.be.true // still unpaid
        expect(await marginAccount.margin(1, alice)).to.eq(ZERO)
    })

    it('liquidateExactRepay (incentivePerDollar < 5%)', async function() {
        // margin = 15*50*.8 = $600, spot = 15*50 = $750, bad debt = - 935 + 269.04 = -665.96
        const [
            { weighted, spot },
            { _isLiquidatable, repayAmount, incentivePerDollar },
            avaxMargin
        ] = await Promise.all([
            marginAccount.weightedAndSpotCollateral(alice),
            marginAccount.isLiquidatable(alice, true),
            marginAccount.margin(2, alice)
        ])
        expect(parseInt(weighted.toNumber() / 1e6)).to.eq(-65) // 600 - 665.96 = -65.96
        expect(parseInt(spot.toNumber() / 1e6)).to.eq(84) // 750 - 665.96
        expect(_isLiquidatable).to.eq(0) // IS_LIQUIDATABLE
        expect(incentivePerDollar.toNumber() / 1e6).to.eq(1.05) // min(1.05, 500/458)

        const repay = _1e6.mul(200) // < 484
        await vusd.connect(admin).mint(liquidator2.address, repay)
        await vusd.connect(liquidator2).approve(marginAccount.address, repay)

        const seizeAmount = repay.mul(incentivePerDollar).div(avaxOraclePrice)
        await expect(
            marginAccount.connect(liquidator2).liquidateExactRepay(alice, repay, 2, seizeAmount.add(1) /* minSeizeAmount */)
        ).to.be.revertedWith('Not seizing enough')

        await marginAccount.connect(liquidator2).liquidateExactRepay(alice, repay, 2, seizeAmount)
        // console.log((await marginAccount.margin(0, alice)).toString())

        expect(await avax.balanceOf(liquidator2.address)).to.eq(seizeAmount)
        expect(await vusd.balanceOf(liquidator2.address)).to.eq(ZERO)
        expect(await marginAccount.margin(0, alice)).to.eq(repayAmount.sub(repay).mul(-1))
        expect(await marginAccount.margin(2, alice)).to.eq(avaxMargin.sub(seizeAmount))
    })

    it('insurance fund settles alice\'s bad debt', async function() {
        const aliceVusdMargin = await marginAccount.margin(0, alice) // ~ -260.91
        avaxMargin = await marginAccount.margin(2, alice) // 5.8063

        // drop collateral value, so that we get bad debt
        oraclePrice = _1e6.mul(40)
        await oracle.setUnderlyingPrice(avax.address, oraclePrice)

        // console.log({
        //     aliceVusdMargin: aliceVusdMargin.toString(),
        //     avaxMargin: avaxMargin.toString(),
        //     getSpotCollateralValue: (await marginAccount.getSpotCollateralValue(alice)).toString()
        // })

        // provide insurance fund with enough vusd to cover deficit
        const bal = await vusd.balanceOf(insuranceFund.address) // trade and liquidation fee
        if (bal.lt(aliceVusdMargin.abs())) {
            await vusd.connect(admin).mint(insuranceFund.address, aliceVusdMargin.abs().sub(bal))
        }
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(aliceVusdMargin.abs())
        expect(await insuranceFund.isAuctionOngoing(avax.address)).to.eq(false)

        const tx = await marginAccount.settleBadDebt(alice)
        auctionTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp

        expect(await marginAccount.margin(0, alice)).to.eq(ZERO)
        expect(await marginAccount.margin(1, alice)).to.eq(ZERO)
        expect(await marginAccount.margin(2, alice)).to.eq(ZERO)
        expect(await avax.balanceOf(insuranceFund.address)).to.eq(avaxMargin)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(ZERO)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2) // NO_DEBT
        // avax auction started
        const avaxAuction = await insuranceFund.auctions(avax.address)
        auctionDuration = await insuranceFund.auctionDuration()
        startPrice = oraclePrice.mul(105).div(100)
        expect(avaxAuction.startedAt).to.eq(auctionTimestamp)
        // endTime = start + auction duration
        expect(avaxAuction.expiryTime).to.eq(auctionDuration.add(auctionTimestamp))
        // startPrice = oraclePrice * 1.05
        expect(avaxAuction.startPrice).to.eq(startPrice)
        expect(await insuranceFund.isAuctionOngoing(avax.address)).to.eq(true)
    })

    it('buy an auction', async function() {
        // increase time by 1 hour
        let elapsedTime = 3600
        await network.provider.send('evm_setNextBlockTimestamp', [auctionTimestamp + elapsedTime]);
        // buy price = startPrice * (auctionDuration - elapsedTime) / auctionDuration
        let buyPrice = startPrice.mul(auctionDuration.sub(elapsedTime)).div(auctionDuration)
        const vusdAmount = buyPrice.mul(avaxMargin).div(1e6)

        // charlie buys auction
        await vusd.connect(charlie).approve(insuranceFund.address, vusdAmount)
        expect(await insuranceFund.getAuctionPrice(avax.address)).to.eq(buyPrice)

        await vusd.connect(admin).mint(charlie.address, vusdAmount)
        await expect(insuranceFund.connect(charlie).buyCollateralFromAuction(avax.address, avaxMargin.add(1))
        ).to.revertedWith('ERC20: transfer amount exceeds balance')

        let seizeAmount = avaxMargin.div(4)
        let tx = await insuranceFund.connect(charlie).buyCollateralFromAuction(avax.address, seizeAmount)
        let blockTime = BigNumber.from((await ethers.provider.getBlock(tx.blockNumber)).timestamp)
        buyPrice = await insuranceFund.getAuctionPrice(avax.address)
        let ifVusdBal = buyPrice.mul(seizeAmount).div(1e6)

        expect(buyPrice).to.eq(startPrice.sub(startPrice.mul(blockTime.sub(auctionTimestamp)).div(auctionDuration)))
        expect(await avax.balanceOf(insuranceFund.address)).to.eq(avaxMargin.sub(seizeAmount))
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(ifVusdBal)
        expect(await insuranceFund.isAuctionOngoing(avax.address)).to.eq(true)
        avaxMargin = avaxMargin.sub(seizeAmount)
        // increase time by 30 min
        await network.provider.send('evm_setNextBlockTimestamp', [ blockTime.add(1800).toNumber() ]);
    })

    it('deposit to IF during auction', async function() {
        deposit = _1e6.mul(500)
        await vusd.connect(admin).mint(alice, deposit)
        await vusd.approve(insuranceFund.address, deposit)

        // test when totalSupply is zero, governance gets all previously available vusd
        const ifVusdBal = await vusd.balanceOf(insuranceFund.address)
        await insuranceFund.deposit(deposit)
        expect(await insuranceFund.balanceOf(alice)).to.eq(deposit)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(deposit)
        expect(await vusd.balanceOf(alice)).to.eq(ifVusdBal)
        expect(await insuranceFund.totalSupply()).to.eq(deposit)

        const poolSpotValue = deposit.add(avaxMargin.mul(oraclePrice).div(1e6))

        // test when totalSupply is non-zero
        await vusd.connect(admin).mint(bob.address, deposit)
        await vusd.connect(bob).approve(insuranceFund.address, deposit)

        await insuranceFund.connect(bob).deposit(deposit)

        const bobShares = deposit.mul(deposit).div(poolSpotValue) // amount * totalSupply / spotValue
        expect(await insuranceFund.balanceOf(bob.address)).to.eq(bobShares)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(deposit.mul(2))
        expect(await insuranceFund.totalSupply()).to.eq(deposit.add(bobShares))
    })

    it('buying all collateral closes the auction', async function() {
        // charlie seizes rest of the assets
        expect(await insuranceFund.isAuctionOngoing(avax.address)).to.eq(true)
        let ifVusdBal = await vusd.balanceOf(insuranceFund.address)
        let tx = await insuranceFund.connect(charlie).buyCollateralFromAuction(avax.address, avaxMargin)
        let blockTime = BigNumber.from((await ethers.provider.getBlock(tx.blockNumber)).timestamp)
        let buyPrice = startPrice.sub(startPrice.mul(blockTime.sub(auctionTimestamp)).div(auctionDuration))
        ifVusdBal = ifVusdBal.add(buyPrice.mul(avaxMargin).div(1e6))

        expect(await avax.balanceOf(insuranceFund.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(ifVusdBal)
        expect(await insuranceFund.isAuctionOngoing(avax.address)).to.eq(false)
    })
})

describe('Partial Liquidation Threshold', async function() {
    beforeEach(async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2, liquidator3, admin ] = signers)
        alice = signers[0].address

        contracts = await setupContracts()
        ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap, hubbleViewer, oracle } = contracts)

        // add margin
        margin = _1e6.mul(2000)
        await addMargin(signers[0], margin)
    })

    it('short -> liquidation -> liquidation', async function() {
        // alice shorts
        const baseAssetQuantity = _1e18.mul(-5)
        await clearingHouse.openPosition2(0, baseAssetQuantity, 0)

        let position = await amm.positions(alice)
        expect(position.liquidationThreshold).to.eq(baseAssetQuantity.mul(25).div(100).abs().add(1))

        // bob increases price
        const base = _1e18.mul(15)
        const price = _1e6.mul(1300)
        await oracle.setUnderlyingPrice(weth.address, price),
        await addMargin(bob, base.mul(price).div(_1e18))
        await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))

        // alice is in liquidation zone
        const feeSinkBalance = await vusd.balanceOf(feeSink)
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        let tx = await clearingHouse.connect(liquidator1).liquidate2(alice)
        const { quoteAsset } = await getTradeDetails(tx, null, 'PositionLiquidated')

        const markPrice = await amm.lastPrice()
        await oracle.setUnderlyingPrice(weth.address, markPrice) // to make amm under spread limit
        // alice has 75% position left
        position = await amm.positions(alice)
        expect(position.size).to.eq(baseAssetQuantity.mul(75).div(100).add(1))
        expect(position.liquidationThreshold).to.eq(baseAssetQuantity.mul(25).div(100).abs().add(1))

        const liquidationPenalty = quoteAsset.mul(5e4).div(_1e6)
        expect(await vusd.balanceOf(feeSink)).to.eq(liquidationPenalty.add(feeSinkBalance))

        // alice is still in liquidation zone
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        await clearingHouse.connect(liquidator1).liquidate2(alice)
        // alice has 50% position left
        position = await amm.positions(alice)
        expect(position.size).to.eq(baseAssetQuantity.mul(50).div(100).add(2))
        expect(position.liquidationThreshold).to.eq(baseAssetQuantity.mul(25).div(100).abs().add(1))
        // alice is out of liquidation zone
        await expect(clearingHouse.connect(liquidator1).liquidate2(alice)).to.be.revertedWith(
            'CH: Above Maintenance Margin'
        )
    })

    it('long -> liquidation -> short', async function() {
        // alice longs
        let baseAssetLong = _1e18.mul(7)
        await clearingHouse.openPosition2(0, baseAssetLong, ethers.constants.MaxUint256)

        let position = await amm.positions(alice)
        expect(position.liquidationThreshold).to.eq(baseAssetLong.mul(25).div(100).add(1))

        // bob decreases price
        const base = _1e18.mul(15)
        const price = _1e6.mul(780)
        await oracle.setUnderlyingPrice(weth.address, price),
        await addMargin(bob, base.mul(price).div(_1e18))
        await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))

        // alice is in liquidation zone
        const feeSinkBalance = await vusd.balanceOf(feeSink)
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        let tx = await clearingHouse.connect(liquidator1).liquidate2(alice)
        const { quoteAsset } = await getTradeDetails(tx, null, 'PositionLiquidated')

        // alice has 75% position left
        position = await amm.positions(alice)
        expect(position.liquidationThreshold).to.eq(baseAssetLong.mul(25).div(100).add(1))
        baseAssetLong = baseAssetLong.mul(75).div(100).sub(1)
        expect(position.size).to.eq(baseAssetLong)
        const liquidationPenalty = quoteAsset.mul(5e4).div(_1e6)
        expect(await vusd.balanceOf(feeSink)).to.eq(liquidationPenalty.add(feeSinkBalance))

        // alice is still in liquidation zone
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        // mine extra block to change block number
        await network.provider.send("evm_mine");
        await clearingHouse.connect(liquidator1).callStatic.liquidate2(alice) // doesn't throw exception

        // alice shorts
        const baseAssetShort = _1e18.mul(-2)
        await clearingHouse.openPosition2(0, baseAssetShort, 0)

        // alice is out of liquidation zone
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
        await expect(clearingHouse.connect(liquidator1).liquidate2(alice)).to.be.revertedWith(
            'CH: Above Maintenance Margin'
        )

        // liquidation threshold updated
        position = await amm.positions(alice)
        expect(position.size).to.eq(baseAssetLong.add(baseAssetShort))
        expect(position.liquidationThreshold).to.eq(position.size.mul(25).div(100).add(1))
    })
})

describe('Liquidation Price Safeguard', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, charlie, liquidator3, admin ] = signers)
        alice = signers[0].address

        contracts = await setupContracts({amm: {initialLiquidity: 5000}})
        ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, weth, oracle } = contracts)

        // add margin
        margin = _1e6.mul(1050)
        await addMargin(signers[0], margin)
        await addMargin(liquidator1, _1e6.mul(20000))

        // alice shorts
        baseAssetQuantity = _1e18.mul(-5)
        await clearingHouse.openPosition2(0, baseAssetQuantity, 0)

        // bob increases the price
        const base = _1e18.mul(15)
        price = _1e6.mul(1130)
        await addMargin(bob, base.mul(price).div(_1e18))
        await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))

        // since both the oracle price and mark price determine whether someone is above the maintenance margin, just increasing the mark price should not be enough
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true

        await oracle.setUnderlyingPrice(weth.address, price.mul(989).div(1000)) // 1st test needs mark > 1% of index
        // alice is in liquidation zone
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
    })

    it('cannot liquidate if liquidationPrice > 1.01 * indexPrice', async function() {
        await amm.setLiquidationSizeRatio(25 * 1e4)
        await amm.setPriceSpreadParams(await amm.maxOracleSpreadRatio(), 1e4)
        const indexPrice = await oracle.getUnderlyingPrice(weth.address)

        expect(await amm.maxLiquidationPriceSpread()).to.eq(_1e6.div(100))
        // expect((price.sub(indexPrice)).mul(1e8).div(indexPrice)).to.gt(_1e6)
        // await expect(clearingHouse.connect(liquidator1).liquidate3(alice, price)).to.be.revertedWith(
        //     'AMM.price_GT_bound'
        // )
    })

    it('cannot liquidate if liquidationPrice < 0.99 * indexPrice', async function() {
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1150))
        const indexPrice = await oracle.getUnderlyingPrice(weth.address)

        expect((price.sub(indexPrice)).mul(1e8).div(indexPrice)).to.lt(_1e6.mul(-1))
        // await expect(clearingHouse.connect(liquidator1).liquidate3(alice, price)).to.be.revertedWith(
        //     'AMM.price_LT_bound'
        // )
    })

    it('can liquidate if markPrice is within 1% of indexPrice and no trades before', async function() {
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1120))

        await network.provider.send("evm_setAutomine", [false]);
        // liquidator1 liquidates alice
        await clearingHouse.connect(liquidator1).liquidate2(alice)
        // liquidator1 long
        await clearingHouse.connect(liquidator1).openPosition2(0, _1e18.mul(1), ethers.constants.MaxUint256)

        // mine next block
        await network.provider.send("evm_mine");
        await network.provider.send("evm_setAutomine", [true]);

        expect((await amm.positions(alice)).size).to.eq(baseAssetQuantity.mul(3).div(4).add(1))
        expect((await clearingHouse.queryFilter('PositionLiquidated')).length).to.eq(1)
    })
})
