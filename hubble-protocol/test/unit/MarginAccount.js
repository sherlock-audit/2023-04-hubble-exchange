const { expect } = require('chai')
const utils = require('../utils')
const {
    setupContracts,
    setupRestrictedTestToken,
    bnToFloat,
} = utils
const { constants: { _1e6, _1e18, ZERO } } = utils

describe('MarginAccount Unit Tests', function() {
    before(async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;([ bob, mockClearingHouse, admin, liquidator ] = signers.slice(10))
    })

    describe('Misc', function() {
        before(async function() {
            ;({ marginAccount, vusd, oracle, clearingHouse, insuranceFund, weth, marginAccountHelper } = await setupContracts({ amm: { initialLiquidity: 0 } }))
            await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address)
        })

        it('reverts when initializing again', async function() {
            await expect(marginAccount.initialize(bob.address, vusd.address)).to.be.revertedWith('Initializable: contract is already initialized')
        })

        it('governance things', async function() {
            expect(await marginAccount.governance()).to.eq(alice)

            await expect(marginAccount.connect(bob).setGovernace(bob.address)).to.be.revertedWith('ONLY_GOVERNANCE')
            await expect(marginAccount.connect(bob).pause()).to.be.revertedWith('ONLY_GOVERNANCE')
            await expect(marginAccount.connect(bob).unpause()).to.be.revertedWith('ONLY_GOVERNANCE')
            await expect(marginAccount.connect(bob).syncDeps(alice, 0)).to.be.revertedWith('ONLY_GOVERNANCE')
            await expect(marginAccount.connect(bob).whitelistCollateral(alice, 0)).to.be.revertedWith('ONLY_GOVERNANCE')
            await expect(marginAccount.connect(bob).changeCollateralWeight(0, 0)).to.be.revertedWith('ONLY_GOVERNANCE')

            await marginAccount.setGovernace(bob.address)
            expect(await marginAccount.governance()).to.eq(bob.address)
            // alice doesn't have priviledges now
            await expect(marginAccount.setGovernace(bob.address)).to.be.revertedWith('ONLY_GOVERNANCE')

            await marginAccount.connect(bob).setGovernace(alice)
            expect(await marginAccount.governance()).to.eq(alice)
        })

        it('reverts when paused', async function() {
            await marginAccount.pause()
            await expect(marginAccount.addMargin(0, 1)).to.be.revertedWith('Pausable: paused')
            await expect(marginAccount.removeMargin(0, 1)).to.be.revertedWith('Pausable: paused')
            await expect(marginAccount.liquidateExactRepay(alice, 1, 1, 0)).to.be.revertedWith('Pausable: paused')
            await expect(marginAccount.liquidateExactSeize(alice, 1, 1, 0)).to.be.revertedWith('Pausable: paused')
            await expect(marginAccount.liquidateFlexible(alice, 1, [1])).to.be.revertedWith('Pausable: paused')
            await expect(marginAccount.settleBadDebt(alice)).to.be.revertedWith('Pausable: paused')
            await marginAccount.unpause()
        })

        it('cannot remove 0 margin', async function() {
            await expect(marginAccount.removeMargin(0,0)).to.be.revertedWith('Remove non-zero margin')
        })

        it('realize fake pnl', async function() {
            await setClearingHouse(mockClearingHouse)
            expect(await vusd.balanceOf(marginAccount.address)).to.eq(0)
            pnl = _1e6.mul(123)
            await marginAccount.connect(mockClearingHouse).realizePnL(alice, pnl)
            expect(await marginAccount.margin(0, alice)).to.eq(pnl)
        })

        it('alice withdraws pnl', async function() {
            // but first we need to revert original clearingHouse, otherwise calls will revert
            await setClearingHouse(clearingHouse)
            expect(await vusd.balanceOf(alice)).to.eq(0)
            await expect(
                marginAccount.removeMarginFor(0, pnl, alice)
            ).to.be.revertedWith('Only marginAccountHelper')

            await marginAccount.removeMargin(0, pnl)

            expect(await vusd.balanceOf(alice)).to.eq(pnl)
            expect(await marginAccount.credit()).to.eq(pnl)
        })

        it('bob deposits margin which is used to settle credit partially', async function() {
            netDeposit = _1e6.mul(125)
            await vusd.connect(admin).mint(bob.address, netDeposit)
            await vusd.connect(bob).approve(marginAccount.address, netDeposit)

            deposit = _1e6.mul(48)
            await marginAccount.connect(bob).addMargin(0, deposit)

            expect(await vusd.balanceOf(bob.address)).to.eq(netDeposit.sub(deposit))
            expect(await vusd.balanceOf(marginAccount.address)).to.eq(ZERO)
            expect(await marginAccount.credit()).to.eq(pnl.sub(deposit))
        })

        it('bob deposits margin which is used to settle all credit', async function() {
            deposit = netDeposit.sub(deposit)
            await marginAccount.connect(bob).addMargin(0, deposit)

            expect(await vusd.balanceOf(bob.address)).to.eq(ZERO)
            expect(await vusd.balanceOf(marginAccount.address)).to.eq(netDeposit.sub(pnl))
            expect(await marginAccount.credit()).to.eq(ZERO)
        })
    })

    describe('Multi-collateral (vusd, avax, weth) liquidations', function() {
        beforeEach(async function() {
            ;({ marginAccount, vusd, oracle, weth } = await setupContracts({ mockMarginAccount: true, amm: { initialLiquidity: 0 } }))

            // whitelist Avax and Weth as collaterals, in that order
            avax = await setupRestrictedTestToken('AVAX', 'AVAX', 6)
            oraclePrice = 1e6 * 3000
            avaxOraclePrice = 1e6 * 50
            await Promise.all([
                oracle.setUnderlyingPrice(avax.address, avaxOraclePrice),
                oracle.setUnderlyingPrice(weth.address, oraclePrice),
            ])
            await marginAccount.whitelistCollateral(avax.address, 0.8 * 1e6)
            await marginAccount.whitelistCollateral(weth.address, 0.8 * 1e6)
            await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address)
        })

        it('liquidateFlexible', async function() {
            const debt = _1e6.mul(29000)
            const avaxMargin = _1e6.mul(230)
            const wethMargin = _1e18.mul(6)
            await marginAccount.setMargin(alice, 0, debt.mul(-1))
            await marginAccount.setMargin(alice, 1, avaxMargin)
            await marginAccount.setMargin(alice, 2, wethMargin)

            ;({ weighted, spot } = await marginAccount.weightedAndSpotCollateral(alice))
            // spot = -29000 + 230*50 + 6*3000 = 500
            // weighted = -29000 + (230*50 + 6*3000)*.8 = -5400
            expect(spot).to.eq(_1e6.mul(500))
            expect(weighted).to.eq(_1e6.mul(-5400))

            // incentivePerDollar = 1 + 500/29k = 1.017241
            const { _isLiquidatable, incentivePerDollar } = await marginAccount.isLiquidatable(alice, true)
            expect(_isLiquidatable).to.eq(0)
            expect(incentivePerDollar).to.eq('1017241')

            // otherwise liquidation will revert due to insufficient balances
            await vusd.connect(admin).mint(liquidator.address, debt)
            await avax.mint(marginAccount.address, avaxMargin)
            await weth.mint(marginAccount.address, wethMargin)

            await vusd.connect(liquidator).approve(marginAccount.address, debt)
            await marginAccount.connect(liquidator).liquidateFlexible(alice, debt, [1,2])

            expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2) // NO_DEBT
            // avax will repay 230 * 50 / 1.017241 ~ 11305.x; debt = 29k-11305.x = 17694.911
            // weth = 17694.911/3000 * 1.017241 = 5.999
            expect(await avax.balanceOf(liquidator.address)).to.eq(avaxMargin)
            expect(
                Math.floor(bnToFloat(await weth.balanceOf(liquidator.address), 18) * 1e3) / 1e3
            ).to.eq(5.999)
        })

        /*
        In this test, we create a scenario where seizing the first collateral, gets alice out of liquidation zone.
        Say, Alice has 230 avax at $50, 6 weth at $3k as margin and a debt of $25k vusd
            - spot = -25000 + 230*50 + 6*3000 = 4500
            - weighted = -25000 + (230*50 + 6*3000)*.8 = -1400
        Alice is in liquidation zone B.
        Seizing Avax will be able to pay 230*50/1.05 = ~$10952 of their debt. Subsequently,
            - spot = -(25000-10952) + 6*3000 = 3952
            - weighted = -(25000-10952) + 6*3000*.8 = 352
        */
        it('seizing 1st collateral gets alice out of liquidation zone B', async function() {
            const debt = _1e6.mul(25000)
            const avaxMargin = _1e6.mul(230)
            const wethMargin = _1e18.mul(6)
            await marginAccount.setMargin(alice, 0, debt.mul(-1))
            await marginAccount.setMargin(alice, 1, avaxMargin)
            await marginAccount.setMargin(alice, 2, wethMargin)

            ;({ weighted, spot } = await marginAccount.weightedAndSpotCollateral(alice))
            expect(spot).to.eq(_1e6.mul(4500))
            expect(weighted).to.eq(_1e6.mul(-1400))
            expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(0) // IS_LIQUIDATABLE

            await vusd.connect(admin).mint(liquidator.address, debt)
            await avax.mint(marginAccount.address, avaxMargin) // otherwise seizing will fail

            await vusd.connect(liquidator).approve(marginAccount.address, debt)
            // doesn't revert
            await marginAccount.connect(liquidator).callStatic.liquidateFlexible(alice, debt, [1])

            // exits silently
            await marginAccount.connect(liquidator).liquidateFlexible(alice, debt, [1, 2])

            ;({ weighted, spot } = await marginAccount.weightedAndSpotCollateral(alice))
            expect(spot).to.eq('3952380952') // 3952
            expect(weighted).to.eq('352380952') // 352
            expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(3) // ABOVE_THRESHOLD
            expect(await avax.balanceOf(liquidator.address)).to.eq(avaxMargin)
            expect(await weth.balanceOf(liquidator.address)).to.eq(ZERO)
            expect(
                (await hubbleViewer.userInfo(alice)).map(b => b.toString())
            ).to.eql(['-14047619048', '0', wethMargin.toString()])
        })
    })
})

async function setClearingHouse(clearingHouse) {
    registry = await Registry.deploy(oracle.address, clearingHouse.address, insuranceFund.address, marginAccount.address, vusd.address, orderBook.address, marginAccountHelper.address)
    await marginAccount.syncDeps(registry.address, 5e4)
}
