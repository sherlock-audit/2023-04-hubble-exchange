const { expect } = require('chai');

const {
    setupContracts,
    calcGasPaid,
    gotoNextIFUnbondEpoch,
    setBalance,
    constants: { _1e6, _1e12, ZERO, _1e18 }
} = require('./utils')

describe('Margin Account Helper Tests', function() {
    before('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ marginAccount, marginAccountHelper, insuranceFund } = await setupContracts())
        initialHgtBalance = _1e18.mul(10000)
        await setBalance(alice, initialHgtBalance.toHexString().replace(/0x0+/, "0x"))
        gasPaid = ZERO
    })

    it('addVUSDMarginWithReserve', async () => {
        margin = _1e6.mul(2000)
        const tx = await marginAccountHelper.addVUSDMarginWithReserve(margin, { value: _1e12.mul(margin) })
        gasPaid = gasPaid.add(await calcGasPaid(tx))

        expect(await marginAccount.margin(0, alice)).to.eq(margin)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin)
        expect(await ethers.provider.getBalance(alice)).to.eq(initialHgtBalance.sub(_1e12.mul(margin)).sub(gasPaid))
        expect(await vusd.balanceOf(alice)).to.eq(ZERO)
        expect(await vusd.balanceOf(marginAccountHelper.address)).to.eq(ZERO)
    })

    it('removeMarginInUSD', async () => {
        const tx = await marginAccountHelper.removeMarginInUSD(margin)
        gasPaid = gasPaid.add(await calcGasPaid(tx))

        expect(await marginAccount.margin(0, alice)).to.eq(ZERO)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(ZERO)
        expect(await ethers.provider.getBalance(alice)).to.eq(initialHgtBalance.sub(gasPaid))
        expect(await vusd.balanceOf(alice)).to.eq(ZERO)
        expect(await vusd.balanceOf(marginAccountHelper.address)).to.eq(ZERO)
    })

    it('depositToInsuranceFund', async () => {
        deposit = _1e6.mul(2000)
        const tx = await marginAccountHelper.depositToInsuranceFund(deposit, { value: _1e12.mul(deposit) })
        gasPaid = gasPaid.add(await calcGasPaid(tx))

        expect(await ethers.provider.getBalance(alice)).to.eq(initialHgtBalance.sub(_1e12.mul(deposit)).sub(gasPaid))
        expect(await insuranceFund.balanceOf(alice)).to.eq(deposit)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(deposit)
        expect(await vusd.balanceOf(alice)).to.eq(ZERO)
        expect(await vusd.balanceOf(marginAccountHelper.address)).to.eq(ZERO)
    })

    it('withdrawFromInsuranceFund', async () => {
        await expect(
            marginAccountHelper.estimateGas.withdrawFromInsuranceFund(deposit)
        ).to.be.revertedWith('withdrawing_more_than_unbond')

        let tx = await insuranceFund.unbondShares(deposit)
        gasPaid = gasPaid.add(await calcGasPaid(tx))

        await expect(
            marginAccountHelper.estimateGas.withdrawFromInsuranceFund(deposit)
        ).to.be.revertedWith('still_unbonding')

        await gotoNextIFUnbondEpoch(insuranceFund, alice)
        tx = await marginAccountHelper.withdrawFromInsuranceFund(deposit)
        gasPaid = gasPaid.add(await calcGasPaid(tx))

        expect(await ethers.provider.getBalance(alice)).to.eq(initialHgtBalance.sub(gasPaid))
        expect(await insuranceFund.balanceOf(alice)).to.eq(ZERO)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(alice)).to.eq(ZERO)
        expect(await vusd.balanceOf(marginAccountHelper.address)).to.eq(ZERO)
    })
})

