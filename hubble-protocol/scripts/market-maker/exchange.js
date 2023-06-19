const ethers = require('ethers')
const { bnToFloat, sleep } = require('../../test/utils')
const { BigNumber } = ethers
const _ = require('lodash')
const crypto = require('crypto')

class Exchange {
    constructor(provider, config) {
        this.provider = provider
        this.config = config
        this.orderBook = new ethers.Contract(
            config.contracts.OrderBook,
            require('../../artifacts/contracts/orderbooks/OrderBook.sol/OrderBook.json').abi,
            this.provider
        )
        this.marginAccount = new ethers.Contract(
            config.contracts.MarginAccount,
            require('../../artifacts/contracts/MarginAccount.sol/MarginAccount.json').abi,
            this.provider
        )
        this.clearingHouse = new ethers.Contract(
            config.contracts.ClearingHouse,
            require('../../artifacts/contracts/ClearingHouse.sol/ClearingHouse.json').abi,
            this.provider
        )
        this.bibliophile = new ethers.Contract(
            config.contracts.Bibliophile,
            require('../../artifacts/contracts/precompiles/IHubbleBibliophile.sol/IHubbleBibliophile.json').abi,
            this.provider
        )
        if (config.contracts.MarginAccountHelper) {
            this.marginAccountHelper = new ethers.Contract(
                config.contracts.MarginAccountHelper,
                require('../../artifacts/contracts/MarginAccountHelper.sol/MarginAccountHelper.json').abi,
                this.provider
            )
        }
        if (config.contracts.HubbleViewer) {
            this.hubbleViewer = new ethers.Contract(
                config.contracts.HubbleViewer,
                require('../../artifacts/contracts/HubbleViewer.sol/HubbleViewer.json').abi,
                this.provider
            )
        }
    }

    async getCurrentPosition(trader, market) {
        const ammAddress = await this.clearingHouse.amms(market)
        const ammAbi = require('../../artifacts/contracts/AMM.sol/AMM.json').abi
        const amm = new ethers.Contract(ammAddress, ammAbi, this.provider)
        const position = await amm.positions(trader)
        return {
            size: bnToFloat(position.size, 18),
            openNotional: bnToFloat(position.openNotional),
            lastPremiumFraction: bnToFloat(position.lastPremiumFraction),
            liquidationThreshold: bnToFloat(position.liquidationThreshold, 18),
        }
    }

    async fetchOrderBook(market) {
        const orders = (await this.provider.send('orderbook_getOrderBook', [market.toString()])).Orders
        // console.log({ orders })
        const bids = orders
            .map(order => ({ price: parseFloat(order.Price) / 1e6, size: parseFloat(order.Size) / 1e18 }))
            .filter(order => order.size > 0)
            .sort((a, b) => b.price - a.price)
        const asks = orders
            .map(order => ({ price: parseFloat(order.Price) / 1e6, size: parseFloat(order.Size) / 1e18 }))
            .filter(order => order.size < 0)
            .sort((a, b) => a.price - b.price)
        return { orders, bids, asks }
    }

    async getTraderOpenOrders(trader, market) {
        return (await this.provider.send('orderbook_getOpenOrders', [trader, market.toString()])).Orders
    }

    async getTraderBidsAndAsks(trader, market) {
        const orders = await this.getTraderOpenOrders(trader, market)
        // console.log({ orders })
        const bids = orders
            .map(order => ({ price: parseFloat(order.Price) / 1e6, size: parseFloat(order.Size) / 1e18, id: order.OrderId, reduceOnly: order.ReduceOnly }))
            .filter(order => order.size > 0)
            .sort((a, b) => b.price - a.price)
        const asks = orders
            .map(order => ({ price: parseFloat(order.Price) / 1e6, size: parseFloat(order.Size) / 1e18, id: order.OrderId, reduceOnly: order.ReduceOnly }))
            .filter(order => order.size < 0)
            .sort((a, b) => a.price - b.price)
        return { orders, bids, asks }
    }

    async cancelAllOrders(signer, txOpts={}) {
        const orders = await this.getTraderOpenOrders(signer.address, '')
        const rawOrders = toRawOrders(signer.address, orders)
        console.log(`Cancelling ${rawOrders.length} orders`)
        return this.cancelOrders(signer, rawOrders, txOpts)
    }

    async getReduceOnlyOrders(trader) {
        const orderBook = (await this.provider.send('orderbook_getOpenOrders', [trader])).Orders
        // console.log({ openOrders: orderBook })
        return _.filter(orderBook, order => order.ReduceOnly == true)
    }

    async fetchTicker() {
        const { bids, asks } = await this.fetchOrderBook(0)
        // console.log({ bids, asks })
        return { bid: bids.length ? bids[0].price : undefined, ask: asks.length ? asks[0].price : undefined }
    }

    async createLimitOrder(signer, dryRun, market, baseAssetQuantity, price, reduceOnly=false, txOpts={}) {
        console.log(`Executing ${baseAssetQuantity > 0 ? 'long' : 'short'} ${baseAssetQuantity} at $${price}`)
        return this.createLimitOrderUnscaled(signer, dryRun, market, ethers.utils.parseEther(baseAssetQuantity.toString()), ethers.utils.parseUnits(price.toFixed(6).toString(), 6), reduceOnly, txOpts)
    }

    async placeOrders(signer, orders, txOpts={}, chunkSize = 20) {
        if (!orders.length) return
        // place chunkSize orders at a time
        const chunks = _.chunk(orders, chunkSize)
        let nonce = txOpts.nonce || await signer.getTransactionCount()
        return Promise.all(chunks.map(chunk => this.orderBook.connect(signer).placeOrders(chunk, Object.assign(txOpts, { nonce: nonce++ }))))
    }

    buildOrderObj(trader, ammIndex, baseAssetQuantity, price, reduceOnly=false) {
        // console.log(trader, ammIndex, baseAssetQuantity, price, reduceOnly)
        return {
            ammIndex,
            trader,
            baseAssetQuantity: ethers.utils.parseEther(baseAssetQuantity.toString()),
            price: ethers.utils.parseUnits(price.toFixed(6).toString(), 6),
            salt: BigNumber.from('0x' + crypto.randomBytes(16).toString('hex')),
            reduceOnly
        }
    }

    async createLimitOrderUnscaled(signer, dryRun, market, baseAssetQuantity, price, reduceOnly=false, txOpts={}) {
        // console.log({ dryRun, baseAssetQuantity, price, reduceOnly })
        if (dryRun || !baseAssetQuantity) return
        const order = {
            ammIndex: market,
            trader: signer.address,
            baseAssetQuantity,
            price,
            salt: BigNumber.from(Date.now()),
            reduceOnly
        }
        // console.log({ order })
        // const orderHash = await this.orderBook.getOrderHash(order)
        // const estimateGas = await this.orderBook.connect(signer).estimateGas.placeOrders([order], signature)
        // console.log({ estimateGas })
        return this.orderBook.connect(signer).placeOrders([order], txOpts)
        // return tx.wait()
    }

    async getMarginFraction(trader) {
        // trader = ethers.utils.getAddress(trader)
        const marginFraction = await this.clearingHouse.calcMarginFraction(trader, false, 0)
        return bnToFloat(marginFraction)
    }

    async fetchOrder(orderHash) {
        const orderInfo = await this.orderBook.orderInfo(orderHash)
        return { status: orderInfo.status }
    }

    async cancelOrders(signer, orders, txOpts={}) {
        if (!orders.length) return
        const chunks = _.chunk(orders, 20)
        let nonce = txOpts.nonce || await signer.getTransactionCount()
        return Promise.all(chunks.map(chunk => this.orderBook.connect(signer).cancelOrders(chunk, Object.assign(txOpts, { nonce: nonce++ }))))
    }

    getPositionSizes(trader) {
        return this.bibliophile.getPositionSizes(trader)
    }

    getNotionalPositionAndMargin(trader) {
        return this.clearingHouse.getNotionalPositionAndMargin(trader, true, 1) // Min_Allowable_Margin
    }

    async getMarginFractionAndPosition(trader) {
        const [ { freeMargin, marginFraction }, sizes ] = await Promise.all([
            this.hubbleViewer.getAccountInfo(trader),
            this.hubbleViewer.userPositions(trader)
        ])
        // console.log({ freeMargin, marginFraction, size })
        return {
            marginFraction: bnToFloat(marginFraction),
            sizes: sizes.map(s => s.size),
            freeMargin: bnToFloat(freeMargin)
        }
    }

    async getUnderlyingPrice() {
        const prices = await this.clearingHouse.getUnderlyingPrice()
        return prices.map(price => bnToFloat(price))
    }
}

const getOpenSize = (orders) => {
    return orders.reduce((accumulator, currentValue) => {
        return accumulator + Math.abs(currentValue.size)
    }, 0)
}

const getOrdersWithinBounds = (orders, lower, upper) => {
    return orders.filter(order => order.price >= lower && order.price <= upper)
}

const prettyPrint = (orders, marketInfo) => {
    return orders.map(order => {
        return {
            market: marketInfo[order.ammIndex].name,
            size: bnToFloat(order.baseAssetQuantity, 18),
            price: `$${bnToFloat(order.price)}`,
            reduceOnly: order.reduceOnly
        }
    })
}

const toRawOrders = (trader, orders) => {
    // console.log({ orders })
    return orders.map(function (order) {
        return {
            ammIndex: order.Market,
            trader,
            baseAssetQuantity: order.Size,
            price: order.Price,
            salt: order.Salt,
            reduceOnly: order.ReduceOnly,
        }
    })
}

const knownErrorTypes = [
    'OB_Order_does_not_exist',
    'OB_cancel_reduce_only_order_first',
    'OB_reduce_only_amount_exceeded',
    'OB_reduce_only_order_must_reduce_position',
    'MA_reserveMargin: Insufficient margin'
]

function findError(str) {
    return knownErrorTypes.find(errorType => str.includes(errorType));
}

function parseAndLogError(e) {
    let shouldLog = true
    if (e && e.error) {
        const err = findError(e.error.toString())
        if (err) {
            console.error(`encountered error`, err)
            shouldLog = false
        }
    }
    if (shouldLog) console.error(e)
}

module.exports = {
    Exchange,
    getOpenSize,
    toRawOrders,
    getOrdersWithinBounds,
    prettyPrint,
    findError,
    parseAndLogError
}
