const { expect } = require('chai')
const utils = require('../utils')
const {
    setupContracts,
    addMargin,
    setupRestrictedTestToken,
    gotoNextIFUnbondEpoch,
    setDefaultClearingHouseParams
} = utils
const { constants: { _1e6, _1e18, ZERO } } = utils

describe('Insurance Fund Unit Tests', function() {
    before('factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;([ bob, charlie, mockMarginAccount, admin ] = signers.slice(10))
        ;({ marginAccount, vusd, oracle, clearingHouse, insuranceFund, marginAccountHelper } = await setupContracts())
        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address)
    })

    it('reverts when initializing again', async function() {
        await expect(insuranceFund.initialize(alice)).to.be.revertedWith('Initializable: contract is already initialized')
    })

    it('deposit', async function() {
        deposit = _1e6.mul(120)
        await vusd.connect(admin).mint(alice, deposit)
        await vusd.approve(insuranceFund.address, deposit)

        await insuranceFund.deposit(deposit)
        expect(await insuranceFund.balanceOf(alice)).to.eq(deposit)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(deposit)
        expect(await vusd.balanceOf(alice)).to.eq(ZERO)
        expect(await insuranceFund.pricePerShare()).to.eq(_1e6)
        expect(await insuranceFund.totalSupply()).to.eq(deposit)
    })

    it('IF gets some fees', async function() {
        fee = _1e6.mul(60)
        // IF has 180 vusd now
        await vusd.connect(admin).mint(insuranceFund.address, fee)
        expect(await insuranceFund.pricePerShare()).to.eq(_1e6.mul(15).div(10))
    })

    it('partial unbond', async function() {
        await expect(
            insuranceFund.unbondShares(deposit.add(1))
        ).to.be.revertedWith('unbonding_too_much')

        withdraw = _1e6.mul(60) // half their shares
        await insuranceFund.unbondShares(withdraw)
        await expect(
            insuranceFund.withdraw(withdraw.add(1))
        ).to.be.revertedWith('withdrawing_more_than_unbond')
        await expect(
            insuranceFund.withdraw(withdraw)
        ).to.be.revertedWith('still_unbonding')
    })

    it('partial withdraw', async function() {
        await gotoNextIFUnbondEpoch(insuranceFund, alice)
        await expect(
            insuranceFund.withdrawFor(alice, withdraw)
        ).to.be.revertedWith('IF.only_margin_account_helper')
        await insuranceFund.withdraw(withdraw)

        // expect(await insuranceFund.balanceOf(alice)).to.eq(deposit.div(2))
        expect(await insuranceFund.totalSupply()).to.eq(deposit.div(2))
        // IF has 90 vusd now
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(_1e6.mul(90))
        expect(await vusd.balanceOf(alice)).to.eq(_1e6.mul(90))
        expect(await insuranceFund.balanceOf(insuranceFund.address)).to.eq(0)
        expect(await insuranceFund.pricePerShare()).to.eq(_1e6.mul(15).div(10)) // remains same
    })

    it('seizeBadDebt', async function() {
        await setMarginAccount(mockMarginAccount)
        debt = _1e6.mul(40)
        await expect(insuranceFund.seizeBadDebt(debt)).to.be.revertedWith('IF.only_margin_account')
        await insuranceFund.connect(mockMarginAccount).seizeBadDebt(debt)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(_1e6.mul(50))
        expect(await vusd.balanceOf(mockMarginAccount.address)).to.eq(debt)
        expect(await insuranceFund.pricePerShare()).to.eq(_1e6.mul(50).mul(_1e6).div(_1e6.mul(60)))
        expect(await insuranceFund.pendingObligation()).to.eq(ZERO)
    })

    it('withdraws still possible', async function() {
        withdraw = _1e6.mul(15) // 25% their shares

        await insuranceFund.unbondShares(_1e6.mul(60))
        await gotoNextIFUnbondEpoch(insuranceFund, alice)

        await insuranceFund.withdraw(withdraw)

        expect(await insuranceFund.totalSupply()).to.eq(_1e6.mul(45))
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(_1e6.mul(375).div(10)) // 50 * 3/4 = 37.5
        expect(await vusd.balanceOf(alice)).to.eq(_1e6.mul(1025).div(10)) // 90 + 50/4
    })

    it('seize more than IF has', async function() {
        seize = _1e6.mul(395).div(10) // 39.5
        await insuranceFund.connect(mockMarginAccount).seizeBadDebt(seize)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(mockMarginAccount.address)).to.eq(_1e6.mul(775).div(10)) // 40 + 37.5
        expect(await insuranceFund.pricePerShare()).to.eq(_1e6)
        expect(await insuranceFund.pendingObligation()).to.eq(_1e6.mul(2))
    })

    it('deposits/withdraws not possible', async function() {
        await expect(insuranceFund.deposit(1)).to.be.revertedWith('IF.deposit.pending_obligations')
        await expect(insuranceFund.withdraw(1)).to.be.revertedWith('IF.withdraw.pending_obligations')
    })

    it('IF gets some fees', async function() {
        await vusd.connect(admin).mint(insuranceFund.address, _1e6.mul(3))
        // (3-2) * precision / totalSupply=45
        expect(await insuranceFund.pricePerShare()).to.eq(_1e6.mul(_1e6).div(_1e6.mul(45)))

        await insuranceFund.settlePendingObligation()

        expect(await insuranceFund.pricePerShare()).to.eq(_1e6.mul(_1e6).div(_1e6.mul(45)))
        expect(await insuranceFund.pendingObligation()).to.eq(ZERO)
        expect(await vusd.balanceOf(mockMarginAccount.address)).to.eq(_1e6.mul(795).div(10)) // 40 + 37.5 + 2
    })

    it('deposits/withdraws active again', async function() {
        await setMarginAccount(marginAccount)
        await vusd.connect(admin).mint(bob.address, 1)
        await vusd.connect(bob).approve(insuranceFund.address, 1)
        await insuranceFund.connect(bob).deposit(1) // pps = 1 / 45

        await insuranceFund.connect(bob).unbondShares(40)

        // can't transfer unbonding shares
        await expect(
            insuranceFund.connect(bob).transfer(charlie.address, 6)
        ).to.be.revertedWith('shares_are_unbonding')

        // can transfer the rest
        await insuranceFund.connect(bob).transfer(charlie.address, 5)
        expect(await insuranceFund.balanceOf(charlie.address)).to.eq(5)
        expect(await insuranceFund.balanceOf(bob.address)).to.eq(40)

        await gotoNextIFUnbondEpoch(insuranceFund, bob.address)
        await insuranceFund.connect(bob).withdraw(39) // leave 2 for next test

        // can't transfer unbonding shares even in withdrawal state
        await expect(
            insuranceFund.connect(bob).transfer(charlie.address, 1)
        ).to.be.revertedWith('shares_are_unbonding')
    })

    it('cant withdraw after withdraw period', async function() {
        await network.provider.send(
            'evm_setNextBlockTimestamp',
            [(await insuranceFund.unbond(bob.address)).unbondTime.toNumber() + 86401]
        );
        await expect(
            insuranceFund.connect(bob).withdraw(1)
        ).to.be.revertedWith('withdraw_period_over')
        await insuranceFund.connect(bob).transfer(charlie.address, 1)
        expect(await insuranceFund.balanceOf(charlie.address)).to.eq(6)
        expect(await insuranceFund.balanceOf(bob.address)).to.eq(0)
    })
})

describe('Insurance Fund Auction Tests', function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, ifLP, auctionBuyer, admin, charlie ] = signers)
        alice = signers[0].address
        ;({ orderBook, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, insuranceFund } = await setupContracts())
        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address) // will mint vusd to liquidators account
        await clearingHouse.setOrderBook(orderBook.address)
        await setDefaultClearingHouseParams(clearingHouse)
        await clearingHouse.setOrderBook(signers[0].address)
        await amm.setLiquidationSizeRatio(1e6)
        await amm.setPriceSpreadParams(1e6, 1e6)

        // addCollateral
        avax = await setupRestrictedTestToken('AVAX', 'AVAX', 18)
        await avax.grantRole(ethers.utils.id('TRANSFER_ROLE'), insuranceFund.address)
        wethOraclePrice = _1e6.mul(1000) // $1k
        avaxOraclePrice = _1e6.mul(50) // $50
        await Promise.all([
            oracle.setUnderlyingPrice(weth.address, wethOraclePrice),
            oracle.setUnderlyingPrice(avax.address, avaxOraclePrice),
        ])
        await marginAccount.whitelistCollateral(weth.address, 0.7 * 1e6), // weight = 0.7
        await marginAccount.whitelistCollateral(avax.address, 0.8 * 1e6) // weight = 0.8
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2) // NO_DEBT

        // addMargin
        wethMargin = _1e18.div(2) // $500
        avaxMargin = _1e18.mul(10) // $500
        await Promise.all([
            weth.mint(alice, wethMargin),
            weth.approve(marginAccount.address, wethMargin),
            avax.mint(alice, avaxMargin),
            avax.approve(marginAccount.address, avaxMargin),
            weth.mint(charlie.address, wethMargin),
            weth.connect(charlie).approve(marginAccount.address, wethMargin),
            avax.mint(charlie.address, avaxMargin),
            avax.connect(charlie).approve(marginAccount.address, avaxMargin),
        ])
        await marginAccount.addMargin(1, wethMargin)
        await marginAccount.addMargin(2, avaxMargin)
        await marginAccount.connect(charlie).addMargin(1, wethMargin)
        await marginAccount.connect(charlie).addMargin(2, avaxMargin)

        // alice and charlie make a trade
        await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)
        await clearingHouse.connect(charlie).openPosition2(0, _1e18.mul(-5), 0)

        // bob increases the mark price
        const base = _1e18.mul(15)
        const price = _1e6.mul(1199)
        await addMargin(bob, base.mul(price).div(_1e18))
        await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))

        // since both the oracle price and mark price determine whether someone is above the maintenance margin, just increasing the mark price should not be enough
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
        expect(await clearingHouse.isAboveMaintenanceMargin(charlie.address)).to.be.true

        // increase the oracle price
        wethOraclePrice = price
        await oracle.setUnderlyingPrice(weth.address, wethOraclePrice)

        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        expect(await clearingHouse.isAboveMaintenanceMargin(charlie.address)).to.be.false

        // liquidate alice and charlie
        await clearingHouse.connect(liquidator1).liquidate2(alice)
        await clearingHouse.connect(liquidator1).liquidate2(charlie.address)

        // alice and charlie have bad debt
        let { spot } = await marginAccount.weightedAndSpotCollateral(alice)
        expect(spot).to.lt(ZERO)
        ;({ spot } = await marginAccount.weightedAndSpotCollateral(charlie.address))
        expect(spot).to.lt(ZERO)

        // add vusd to IF, auctionBuyer
        const amount = _1e6.mul(10000)
        await vusd.connect(admin).mint(insuranceFund.address, amount)
        await vusd.connect(admin).mint(auctionBuyer.address, amount)
        await vusd.connect(auctionBuyer).approve(insuranceFund.address, amount)
    })

    it('settleBadDebt starts auction', async function() {
        // settle alice bad debt
        const tx = await marginAccount.settleBadDebt(alice)
        auctionTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp
        auctionDuration = await insuranceFund.auctionDuration()
        await validateAuction(avax.address, auctionTimestamp, auctionDuration, avaxOraclePrice)
        await validateAuction(weth.address, auctionTimestamp, auctionDuration, wethOraclePrice)
    })

    it('close auction by buying collateral', async function() {
        // increase time by 1 hour
        await network.provider.send('evm_setNextBlockTimestamp', [auctionTimestamp + 3600]);
        await insuranceFund.connect(auctionBuyer).buyCollateralFromAuction(avax.address, avaxMargin)

        expect(await avax.balanceOf(insuranceFund.address)).to.eq(ZERO)
        expect(await insuranceFund.isAuctionOngoing(avax.address)).to.eq(false)
        expect(await insuranceFund.isAuctionOngoing(weth.address)).to.eq(true)
    })

    it('settleBadDebt affects only closed auctions', async function() {
        const tx = await marginAccount.settleBadDebt(charlie.address)
        newAuctionTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp
        await validateAuction(avax.address, newAuctionTimestamp, auctionDuration, avaxOraclePrice)
        await validateAuction(weth.address, auctionTimestamp, auctionDuration, wethOraclePrice)
    })

    it('auction expired due to time limit', async function() {
        await network.provider.send('evm_setNextBlockTimestamp', [ auctionDuration.toNumber() + newAuctionTimestamp + 1])

        await expect(insuranceFund.connect(auctionBuyer).buyCollateralFromAuction(avax.address, avaxMargin)
        ).to.revertedWith('IF.no_ongoing_auction')

        await expect(insuranceFund.connect(auctionBuyer).buyCollateralFromAuction(weth.address, wethMargin)
        ).to.revertedWith('IF.no_ongoing_auction')
    })
})

async function setMarginAccount(marginAccount) {
    registry = await Registry.deploy(oracle.address, clearingHouse.address, insuranceFund.address, marginAccount.address, vusd.address, orderBook.address, marginAccountHelper.address)
    await insuranceFund.syncDeps(registry.address)
}

async function validateAuction(token, auctionTimestamp, auctionDuration, oraclePrice) {
    const auction = await insuranceFund.auctions(token)
    expect(auction.startedAt).to.eq(auctionTimestamp)
    expect(auction.expiryTime).to.eq(auctionDuration.add(auctionTimestamp))
    const startPrice = oraclePrice.mul(105).div(100)
    expect(auction.startPrice).to.eq(startPrice)
    expect(await insuranceFund.isAuctionOngoing(token)).to.eq(true)
}
