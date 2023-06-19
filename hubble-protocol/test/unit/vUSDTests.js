const { expect } = require('chai')
const utils = require('../utils')

const { constants: { _1e6, ZERO, _1e18 }, setBalance, calcGasPaid } = utils
const defaultInitialBalance = _1e18.mul(10000)

describe('vUSD Unit Tests', function() {
    before('factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        admin = signers[11]

        ;([ ERC20Mintable, TransparentUpgradeableProxy, ProxyAdmin, VUSD ] = await Promise.all([
            ethers.getContractFactory('ERC20Mintable'),
            ethers.getContractFactory('TransparentUpgradeableProxy'),
            ethers.getContractFactory('ProxyAdmin'),
            ethers.getContractFactory('VUSD'),
        ]))
        proxyAdmin = await ProxyAdmin.deploy()

        amount = _1e6.mul(123)
    })

    describe('minter role', async function() {
        before('deploy vUSD', async function() {
            vusd = await setupVusd()
            minterRole = await vusd.MINTER_ROLE()
        })

        it('reverts when initializing again', async function() {
            await expect(vusd.initialize("dummy name", "DUM")).to.be.revertedWith('Initializable: contract is already initialized')
        })

        it('mint fails without minter role', async function() {
            expect(await vusd.hasRole(minterRole, admin.address)).to.be.false
            await expect(
                vusd.connect(admin).mint(alice, amount)
            ).to.be.revertedWith('ERC20PresetMinterPauser: must have minter role to mint')
        })

        it('grant minter role', async function() {
            await vusd.grantRole(minterRole, admin.address)
            expect(await vusd.hasRole(minterRole, admin.address)).to.be.true
        })

        it('minter can freely mint', async function() {
            await vusd.connect(admin).mint(alice, amount)
            expect(await vusd.balanceOf(alice)).to.eq(amount)
        })

        it('revoke minter role', async function() {
            await vusd.revokeRole(minterRole, admin.address)
            expect(await vusd.hasRole(minterRole, admin.address)).to.be.false
        })

        it('mint fails after minter role is revoked', async function() {
            await expect(
                vusd.connect(admin).mint(alice, amount)
            ).to.be.revertedWith('ERC20PresetMinterPauser: must have minter role to mint')
        })
    })

    describe('withdrawal Q', async function() {
        before('deploy vUSD', async function() {
            vusd = await setupVusd()
            aliceInitialBalance = await ethers.provider.getBalance(alice)
            gasPaid = ZERO
        })

        it('mintWithReserve', async function() {
            const tx = await vusd.mintWithReserve(alice, amount, {value: amount.mul(1e12)})
            gasPaid = gasPaid.add(await calcGasPaid(tx))
            expect(await vusd.balanceOf(alice)).to.eq(amount)
            expect(await ethers.provider.getBalance(alice)).to.eq(aliceInitialBalance.sub(amount.mul(1e12)).sub(gasPaid))
            expect(await ethers.provider.getBalance(vusd.address)).to.eq(amount.mul(1e12))
        })

        it('alice withdraws', async function() {
            const tx = await vusd.withdraw(amount)
            gasPaid = gasPaid.add(await calcGasPaid(tx))
            expect(await vusd.balanceOf(alice)).to.eq(ZERO)
            expect(await vusd.totalSupply()).to.eq(ZERO)

            const withdrawalQueue = await vusd.withdrawalQueue()
            expect(withdrawalQueue[0].usr).to.eq(alice)
            expect(withdrawalQueue[0].amount).to.eq(amount.mul(1e12))
        })

        it('processWithdrawals', async function() {
            const tx = await vusd.processWithdrawals()
            gasPaid = gasPaid.add(await calcGasPaid(tx))
            expect(await ethers.provider.getBalance(alice)).to.eq(aliceInitialBalance.sub(gasPaid))
            expect(await ethers.provider.getBalance(vusd.address)).to.eq(ZERO)
        })

        it('multiple mintWithReserve', async function () {
            let trader, _amount;
            gasPaidMultipleUsers = [];
            for (let i = 1; i <= 10; i++) {
                trader = signers[i]
                _amount = amount.mul(i)
                gasPaidMultipleUsers[i] = await mintVusdWithReserve(trader, _amount)
                expect(await vusd.balanceOf(trader.address)).to.eq(_amount)
            }
            expect(await ethers.provider.getBalance(vusd.address)).to.eq(_1e18.mul(6765))
        })

        it('too [smol/big] withdraw fails', async function () {
            await expect(
                vusd.withdraw(_1e6.mul(5).sub(1))
            ).to.be.revertedWith('min withdraw is 5 vusd')

            await expect(
                vusd.connect(signers[1]).withdraw(amount.add(1))
            ).to.be.revertedWith('ERC20: burn amount exceeds balance')
        })

        it('multiple withdrawals', async function () {
            for (let i = 1; i <= 10; i++) {
                const tx = await vusd.connect(signers[i]).withdraw(amount.mul(i))
                gasPaidMultipleUsers[i] = gasPaidMultipleUsers[i].add(await calcGasPaid(tx))
                expect(await vusd.balanceOf(signers[i].address)).to.eq(ZERO)
            }
            expect(await vusd.totalSupply()).to.eq(ZERO)

            const withdrawalQueue = await vusd.withdrawalQueue()
            expect(withdrawalQueue.length).to.eq(10)
            expect(withdrawalQueue[0].usr).to.eq(signers[1].address)
            expect(withdrawalQueue[0].amount).to.eq(amount.mul(1e12))
            expect(withdrawalQueue[1].usr).to.eq(signers[2].address)
            expect(withdrawalQueue[1].amount).to.eq(amount.mul(2e12))
            expect(withdrawalQueue[9].usr).to.eq(signers[10].address)
            expect(withdrawalQueue[9].amount).to.eq(amount.mul(10e12))
        })

        it('process multiple withdrawals', async function () {
            await vusd.processWithdrawals()
            // signer[1] paid little gas while asserting withdraw fail tx
            expect(await ethers.provider.getBalance(signers[1].address)).to.lt(defaultInitialBalance.sub(gasPaidMultipleUsers[1]))
            for (let i = 2; i <= 10; i++) {
                expect(await ethers.provider.getBalance(signers[i].address)).to.eq(defaultInitialBalance.sub(gasPaidMultipleUsers[i]))
            }
            expect(await ethers.provider.getBalance(vusd.address)).to.eq(ZERO)
        })
    })

    describe('partial withdrawals', async function() {
        before('deploy vUSD', async function() {
            vusd = await setupVusd()
            gasPaidMultipleUsers = []
        })

        it('process partial withdrawals', async function () {
            let _amount
            for (let i = 1; i <= 5; i++) {
                // set default balance
                await setBalance(signers[i].address, defaultInitialBalance.toHexString().replace(/0x0+/, "0x"))
                _amount = amount.mul(i)
                gasPaidMultipleUsers[i] = await mintVusdWithReserve(signers[i], _amount)
                const tx = await vusd.connect(signers[i]).withdraw(_amount)
                gasPaidMultipleUsers[i] = gasPaidMultipleUsers[i].add(await calcGasPaid(tx))
                expect(await ethers.provider.getBalance(signers[i].address)).to.eq(
                    defaultInitialBalance.sub(_amount.mul(1e12)).sub(gasPaidMultipleUsers[i])
                )
            }

            // free mints will cause usdc balance enough for only first 5 withdrawals
            await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address)
            for (let i = 6; i <= 10; i++) {
                _amount = amount.mul(i)
                await vusd.connect(admin).mint(signers[i].address, _amount)
                // set default balance
                await setBalance(signers[i].address, defaultInitialBalance.toHexString().replace(/0x0+/, "0x"))
                const tx = await vusd.connect(signers[i]).withdraw(_amount)
                gasPaidMultipleUsers[i] = await calcGasPaid(tx)
            }

            const vusdHGTBalance = await ethers.provider.getBalance(vusd.address)
            const spareGasToken = _1e18.mul(20)
            await setBalance(vusd.address, vusdHGTBalance.add(spareGasToken).toHexString().replace(/0x0+/, "0x"))

            await vusd.processWithdrawals()

            for (let i = 1; i <= 5; i++) {
                expect(await ethers.provider.getBalance(signers[i].address)).to.eq(defaultInitialBalance.sub(gasPaidMultipleUsers[i]))
            }
            for (let i = 6; i <= 10; i++) {
                expect(await ethers.provider.getBalance(signers[i].address)).to.eq(
                    defaultInitialBalance.sub(gasPaidMultipleUsers[i])
                )
            }
            expect(await ethers.provider.getBalance(vusd.address)).to.eq(spareGasToken)
        })

        it('revert if not enough balance', async function () {
            await expect(vusd.processWithdrawals()).to.be.revertedWith('Cannot process withdrawals at this time: Not enough balance')
        })

        it('process oldest withdrawal request when enough balance is available', async function () {
            const vusdHGTBalance = await ethers.provider.getBalance(vusd.address)
            const addAmount = _1e18.mul(800)
            await setBalance(vusd.address, vusdHGTBalance.add(addAmount).toHexString().replace(/0x0+/, "0x"))

            // minimum required = 123*6 = 738
            await vusd.processWithdrawals()
            expect(await ethers.provider.getBalance(signers[6].address)).to.eq(
                defaultInitialBalance.sub(gasPaidMultipleUsers[6]).add(_1e18.mul(738))
            )
            expect(await ethers.provider.getBalance(signers[7].address)).to.eq(defaultInitialBalance.sub(gasPaidMultipleUsers[7]))

            expect(await ethers.provider.getBalance(vusd.address)).to.eq(_1e18.mul(82)) //  20 (initial) + 800 (deposited) - 738 (withdrawn)
        })
    })

    async function mintVusdWithReserve(trader, _amount) {
        const tx = await vusd.connect(trader).mintWithReserve(trader.address, _amount, {value: _amount.mul(1e12)})
        const gasPaid = await calcGasPaid(tx)
        return gasPaid
    }

    async function setupVusd() {
        // bdw, not a proxy
        const vusd = await VUSD.deploy()
        await vusd.initialize('Hubble USD', 'hUSD')
        return vusd
    }
})
