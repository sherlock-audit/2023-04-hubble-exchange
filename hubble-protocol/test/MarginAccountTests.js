const { expect } = require('chai');

const {
    setupContracts,
    setupRestrictedTestToken,
    addMargin,
    constants: { _1e6, _1e18 }
} = require('./utils')

describe('Margin Account Tests', function() {
    before('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, usdc, oracle } = await setupContracts())
    })

    it('addVUSDMarginWithReserve', async () => {
        margin = _1e6.mul(2000)
        await addMargin(signers[0] /** alice */, margin)

        expect(await marginAccount.margin(0, alice)).to.eq(margin)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin)
    })

    it('removeMargin', async () => {
        margin = margin.div(2)
        await marginAccount.removeMargin(0, margin);

        expect(await marginAccount.margin(0, alice)).to.eq(margin)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin)
    })

    it('addCollateral', async () => {
        weth = await setupRestrictedTestToken('weth', 'weth', 18)
        await oracle.setUnderlyingPrice(weth.address, 1e6 * 2000) // $2k

        await marginAccount.whitelistCollateral(weth.address, 1e6) // weight = 1

        const supportedCollateral = await marginAccount.supportedCollateral(1);
        expect(supportedCollateral.token).to.eq(weth.address)
        expect(supportedCollateral.decimals).to.eq(18)
    })

    it('addMargin', async () => {
        const amount = _1e18
        await weth.mint(alice, amount)
        await weth.approve(marginAccount.address, amount)
        await marginAccount.addMargin(1, amount);

        expect(await marginAccount.margin(0, alice)).to.eq(margin)
        expect(await marginAccount.margin(1, alice)).to.eq(amount)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(_1e6.mul(2000).add(margin))
    })

    it('removeMargin', async () => {
        const amount = _1e18.div(2)
        await marginAccount.removeMargin(1, amount);

        expect(await marginAccount.margin(0, alice)).to.eq(margin)
        expect(await marginAccount.margin(1, alice)).to.eq(amount)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(_1e6.mul(2000).div(2).add(margin))
    })

    it('change collateral weight', async () => {
        let supportedCollateral = await marginAccount.supportedCollateral(1);
        expect(supportedCollateral.weight).to.eq(1e6)

        const weight = 8e5 // weight = 0.8
        await marginAccount.changeCollateralWeight(1, 8e5)
        supportedCollateral = await marginAccount.supportedCollateral(1);
        expect(supportedCollateral.token).to.eq(weth.address)
        expect(supportedCollateral.decimals).to.eq(18)
        expect(supportedCollateral.weight).to.eq(weight)
    })
})

