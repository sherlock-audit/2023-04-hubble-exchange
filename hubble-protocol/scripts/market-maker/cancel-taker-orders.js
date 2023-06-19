const ethers = require('ethers')
const _ = require('lodash')

const config = require('../hubblev2next')
const { Exchange } = require('./exchange')
const { bnToFloat } = require('../../test/utils')

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY_TAKER, provider);
const exchange = new Exchange(provider, config)

const cancelAllOrders = async () => {
    return exchange.cancelAllOrders(signer);
};

async function showNonce() {
    console.log(await signer.getTransactionCount())
}

const getAllOrders = async () => {
    const orderBook = new ethers.Contract(
        config.contracts.OrderBook,
        require('../../artifacts/contracts/orderbooks/OrderBook.sol/OrderBook.json').abi,
        provider
    )

    // console.log(await orderBook.reduceOnlyAmount(signer.address, 0))

    let events = (await orderBook.queryFilter(orderBook.filters.OrdersMatched()))
    .concat(
        await orderBook.queryFilter(orderBook.filters.OrderPlaced(signer.address))
    )
    .concat(
        await orderBook.queryFilter(orderBook.filters.OrderCancelled(signer.address))
    )
    .map(e => _.pick(e, ['blockNumber', 'event', 'args', 'logIndex'])).sort(function (a, b) {
        if (b.blockNumber == a.blockNumber) return b.logIndex - a.logIndex
        return b.blockNumber - a.blockNumber
    })
    events.map(e => {
        if (e.event === 'OrderPlaced') {
            const args = _.pick(e.args, ['order', 'timestamp', 'orderHash'])
            // console.log(args, args.order.baseAssetQuantity, bnToFloat(args.order.baseAssetQuantity, 18))
            args.timestamp = args.timestamp.toNumber()
            args.order = _.pick(args.order, ['baseAssetQuantity', 'price', 'reduceOnly'])
            args.order.baseAssetQuantity = bnToFloat(args.order.baseAssetQuantity, 18)
            args.order.price = bnToFloat(args.order.price)
            e.args = args
        } else if (e.event === 'OrderCancelled') {
        } else if (e.event === 'OrdersMatched') {
            const args = _.pick(e.args, ['orderHash0', 'orderHash1', 'fillAmount', 'timestamp', 'price'])
            args.timestamp = args.timestamp.toNumber()
            args.fillAmount = bnToFloat(args.fillAmount, 18)
            args.price = bnToFloat(args.price)
            e.args = args
        }
    })
    console.dir(events, { depth: null})
}

cancelAllOrders()
// getAllOrders()
.then(() => process.exit(0))
