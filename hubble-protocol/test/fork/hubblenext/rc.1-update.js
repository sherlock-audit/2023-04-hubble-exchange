const { expect } = require('chai')
const { ethers } = require('hardhat')

const hubblev2next = require('../../../scripts/hubblev2next')
const config = hubblev2next.contracts

const {
    impersonateAccount,
    constants: { _1e18, ZERO, _1e6 }
} = require('../../utils')

const deployer = '0xeAA6AE79bD3d042644D91edD786E4ed3d783Ca2d'
const taker = '0xCe743BFA1feaed060adBadfc8974be544b251Fe8'
const validator = '0x393bd9ac9dbBe75e84db739Bb15d22cA86D26696' // N. Virgina

describe.skip('hubblenext-rc.1 update', async function() {
    let blockNumber = 368061

    before(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: `https://hubblenext-archive-rpc.hubble.exchange/ext/bc/iKMFgo49o4X3Pd3UWUkmPwjKom3xZz3Vo6Y1kkwL2Ce6DZaPm/rpc`,
                    blockNumber
                }
            }]
        })

        ;([ orderBook, bibliophile, marginAccount, clearingHouse ] = await Promise.all([
            ethers.getContractAt('OrderBook', config.OrderBook),
            ethers.getContractAt('IHubbleBibliophile', config.Bibliophile),
            ethers.getContractAt('MarginAccount', config.MarginAccount),
            ethers.getContractAt('ClearingHouse', config.ClearingHouse),
        ]))

        await impersonateAccount(deployer)
        signer = ethers.provider.getSigner(deployer)
        proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('deployer owns proxyAdmin', async function() {
        expect(await proxyAdmin.owner()).to.equal(deployer)
    })

    it('confirm proxyAdmin is indeed admin', async function() {
        for (let i = 0; i < config.amms.length; i++) {
            let admin = await ethers.provider.getStorageAt(config.amms[i].address, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103')
            admin = `0x${admin.slice(26).toLowerCase()}`
            // console.log(i, admin)
            expect(admin).to.equal(config.proxyAdmin.toLowerCase())
            expect(await proxyAdmin.getProxyAdmin(config.amms[i].address)).to.equal(config.proxyAdmin)
        }
        expect(await proxyAdmin.getProxyAdmin(config.ClearingHouse)).to.equal(config.proxyAdmin)
        // console.log(await proxyAdmin.getProxyAdmin(config.OrderBook))
        expect(await proxyAdmin.getProxyAdmin(config.OrderBook)).to.equal(config.proxyAdmin)
    })

    it('update contract', async function() {
        const AMM = await ethers.getContractFactory('AMM')
        const newAMM = await AMM.connect(signer).deploy(config.ClearingHouse)
        console.log({ newAMM: newAMM.address })

        const ClearingHouse = await ethers.getContractFactory('ClearingHouse')
        const newClearingHouse = await ClearingHouse.connect(signer).deploy()
        console.log({ newClearingHouse: newClearingHouse.address })

        const OrderBook = await ethers.getContractFactory('OrderBook')
        const newOrderBook = await OrderBook.connect(signer).deploy(config.ClearingHouse, config.MarginAccount)
        console.log({ newOrderBook: newOrderBook.address })

        const tasks = []
        for (let i = 0; i < config.amms.length; i++) {
            tasks.push(proxyAdmin.connect(signer).upgrade(config.amms[i].address, newAMM.address))
        }
        tasks.push(proxyAdmin.connect(signer).upgrade(config.ClearingHouse, newClearingHouse.address))
        tasks.push(proxyAdmin.connect(signer).upgrade(config.OrderBook, newOrderBook.address))

        const txs = await Promise.all(tasks)
        for (let i = 0; i < txs.length; i++) {
            const r = await txs[i].wait()
            // console.log(r)
            expect(r.status).to.equal(1)
        }
    })

    it('place order', async function() {
        // fork tests with bibliophile don't work because hardhat is unable to find the contract
        await orderBook.connect(ethers.provider.getSigner(deployer)).setBibliophile('0x0000000000000000000000000000000000000000')
        await marginAccount.connect(ethers.provider.getSigner(deployer)).setBibliophile('0x0000000000000000000000000000000000000000')
        await clearingHouse.connect(ethers.provider.getSigner(deployer)).setBibliophile('0x0000000000000000000000000000000000000000')

        longOrder = {
            ammIndex: 0,
            trader: taker,
            baseAssetQuantity: _1e18,
            price: '1746029200',
            salt: Date.now(),
            reduceOnly: false
        }
        await impersonateAccount(taker)
        // const estimateGas = await orderBook.connect(ethers.provider.getSigner(taker)).estimateGas.placeOrders([longOrder])
        // console.log({ estimateGas })
        const tx = await (await orderBook.connect(ethers.provider.getSigner(taker)).placeOrders([longOrder])).wait()
        expect(tx.status).to.equal(1)
    })

    it('check order matching', async function() {
        const amm = await ethers.getContractAt('AMM', config.amms[0].address)
        const openInterestNotional = await amm.openInterestNotional()
        // let's fulfill this short order on eth market
        // reduce only order, so OI will decrease
        shortOrder = {
            ammIndex: 0,
            trader: '0xca6cb508b21f28c599ab1ce6640d11900f6b70ad',
            baseAssetQuantity: '-139780000000000000000',
            price: '1746029200',
            salt: '1686736387458',
            reduceOnly: true
        }
        await impersonateAccount(validator)
        const tx = await (await orderBook.connect(ethers.provider.getSigner(validator)).executeMatchedOrders([longOrder, shortOrder], _1e18)).wait()
        expect(tx.status).to.equal(1)
        // console.log(tx)
        const OrdersMatchedEvent = tx.events.find(e => e.event === 'OrdersMatched')
        // the taker has a short position on this block. so going long will reduce it
        expect(OrdersMatchedEvent.args.openInterestNotional).to.equal(openInterestNotional.sub(_1e18.mul(2)))
    })
})
