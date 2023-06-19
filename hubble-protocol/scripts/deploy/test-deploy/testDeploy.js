const utils = require('../../../test/utils')
const { BigNumber } = require('ethers')
const { ethers } = require('hardhat');
const Bluebird = require('bluebird')
const config  = require('./config.json')

const {
    constants: { ZERO, _1e6 },
    txOptions
} = utils

const gasLimit = 5e6

async function placeMultipleOrders(num) {
    const signers = await ethers.getSigners()
    const [admin, alice, bob] = signers
    console.log({ alice: alice.address, bob: bob.address });

    const orderBook = await ethers.getContractAt('OrderBook', config.contracts.OrderBook)
    const marginAccount = await ethers.getContractAt('MarginAccount', config.contracts.MarginAccount)

    const domain = {
        name: 'Hubble',
        version: '2.0',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: orderBook.address
    }

    const orderType = {
        Order: [
            // field ordering must be the same as LIMIT_ORDER_TYPEHASH
            { name: "ammIndex", type: "uint256" },
            { name: "trader", type: "address" },
            { name: "baseAssetQuantity", type: "int256" },
            { name: "price", type: "uint256" },
            { name: "salt", type: "uint256" },
            { name: "reduceOnly", type: "bool" },
        ]
    }
    let shortOrder = {
        ammIndex: ZERO,
        trader: alice.address,
        baseAssetQuantity: ethers.utils.parseEther('-5'),
        price: ethers.utils.parseUnits('200', 6),
        salt: BigNumber.from(Date.now()),
        reduceOnly: false
    }

    time = Date.now()
    let order = shortOrder
    let trader, price
    let size = 5
    // price: ethers.utils.parseUnits('1000', 6),
    let longPrice = 2000
    let shortPrice = 2000

    // const indexArr = Array.from({ length: num }, (v, k) => k + 1)
    // await Bluebird.map(indexArr, async i => {
    for (let i = 0; i < num; i++) {
        if (i % 20 == 0) {
            size *= -1
            await utils.sleep(10)
        }

        if (i % 2 == 0) {
            // long by alice
            trader = alice
            // longPrice += 1
            price = longPrice
            order.baseAssetQuantity = ethers.utils.parseEther(size.toString())
        } else {
            // short by bob
            trader = bob
            // shortPrice += 1
            price = shortPrice
            order.baseAssetQuantity = ethers.utils.parseEther((-size).toString())
        }
        order.price = ethers.utils.parseUnits(price.toString(), 6)
        order.trader = trader.address
        order.salt = BigNumber.from(time + i)

        signature = await trader._signTypedData(domain, orderType, order)
        // console.log({order, trader: trader.address});
        tx = await orderBook.connect(trader).placeOrder(order, signature, { gasLimit })
        // await tx.wait()
        await utils.sleep(4)
        console.log({ i });
    }
    // }, { concurrency: 1 })
}

async function logData() {
    const signers = await ethers.getSigners()
    const [, alice, bob] = signers
    const hubbleViewer = await ethers.getContractAt('HubbleViewer', config.contracts.HubbleViewer)
    const marginAccount = await ethers.getContractAt('MarginAccount', config.contracts.MarginAccount)
    const orderBook = await ethers.getContractAt('OrderBook', config.contracts.OrderBook)
    vusd = await ethers.getContractAt('VUSD', config.contracts.vusd)
    const amount = _1e6.mul(40000)
    txOptions.gasLimit = 5e6
    // console.log(await ethers.provider.getBalance(alice.address))
    // console.log(await vusd.balanceOf(alice.address))
    // // await addVUSDWithReserve(alice, amount)
    // console.log('hello')
    // console.log(await ethers.provider.getBalance(bob.address))
    // console.log(await vusd.balanceOf(bob.address))
    // console.log(await vusd.balanceOf(marginAccount.address))
    // console.log(await marginAccount.margin(0, alice.address))
    // console.log(await marginAccount.margin(0, bob.address))
    const alicePositions = await hubbleViewer.userPositions(alice.address)
    const bobPositions = await hubbleViewer.userPositions(bob.address)
    console.log({ alicePositions, bobPositions })
}

placeMultipleOrders(2)
// logData()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });

