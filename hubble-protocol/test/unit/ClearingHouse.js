const { expect } = require('chai')
const { BigNumber } = require('ethers')
const utils = require('../utils')
const {
    setupContracts
} = utils
const { constants: { _1e6, ZERO } } = utils

describe('ClearingHouse Unit Tests', function() {
    before('factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;([ bob, mockClearingHouse, admin ] = signers.slice(10))
        ;({ marginAccount, vusd, oracle, clearingHouse, insuranceFund } = await setupContracts({ testClearingHouse: false, mockOrderBook: false }))
    })

    it('storage slots are as expected', async function() {
        // Test fixed slot for maintenanceMargin
        const VAR_MAINTENANCE_MARGIN_SLOT = 1
        storage = await ethers.provider.getStorageAt(
            clearingHouse.address,
            ethers.utils.solidityPack(['uint256'], [VAR_MAINTENANCE_MARGIN_SLOT])
        )
        maintenanceMargin = await clearingHouse.maintenanceMargin()
        expect(BigNumber.from(storage)).to.eq(maintenanceMargin)

        // Test fixed slot for minAllowableMargin
        const VAR_MIN_ALLOWABLE_MARGIN_SLOT = 2
        storage = await ethers.provider.getStorageAt(
            clearingHouse.address,
            ethers.utils.solidityPack(['uint256'], [VAR_MIN_ALLOWABLE_MARGIN_SLOT])
        )
        minAllowableMargin = await clearingHouse.minAllowableMargin()
        expect(BigNumber.from(storage)).to.eq(minAllowableMargin)
    })

    it('reverts when initializing again', async function() {
        await expect(clearingHouse.initialize(alice, alice, alice, alice, alice, alice)).to.be.revertedWith('Initializable: contract is already initialized')
    })

    it('governance things', async function() {
        expect(await clearingHouse.governance()).to.eq(alice)

        await expect(clearingHouse.connect(bob).setGovernace(bob.address)).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(clearingHouse.connect(bob).pause()).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(clearingHouse.connect(bob).unpause()).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(clearingHouse.connect(bob).whitelistAmm(alice)).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(clearingHouse.connect(bob).setParams(0, 0, 0, 0, 0, 0, 0)).to.be.revertedWith('ONLY_GOVERNANCE')

        await clearingHouse.setGovernace(bob.address)
        expect(await clearingHouse.governance()).to.eq(bob.address)
        // alice doesn't have priviledges now
        await expect(clearingHouse.setGovernace(bob.address)).to.be.revertedWith('ONLY_GOVERNANCE')

        await clearingHouse.connect(bob).setGovernace(alice)
        expect(await clearingHouse.governance()).to.eq(alice)
    })
})
