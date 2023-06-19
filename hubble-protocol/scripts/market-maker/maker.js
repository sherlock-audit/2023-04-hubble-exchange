const ethers = require('ethers')

const { Exchange, getOpenSize, getOrdersWithinBounds, prettyPrint, toRawOrders, findError } = require('./exchange');
const { bnToFloat } = require('../../test/utils');
const config = require('../hubblev2next')
const { marketInfo } = config

const updateFrequency = 10e3 // 10s
const dryRun = false
const maxLeverage = 1.9
const numOrders = 15;

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY_MAKER, provider);
const exchange = new Exchange(provider, config)
let nonce

const marketMaker = async () => {
    try {
        const underlyingPrices = await exchange.getUnderlyingPrice()
        // only works if bibliophile is deployed
        const sizes = (await exchange.getPositionSizes(signer.address)).map(s => bnToFloat(s, 18))
        let { margin } = await exchange.getNotionalPositionAndMargin(signer.address)
        margin = bnToFloat(margin)

        // const underlyingPrices = [1850, 17, 26000, 1.2, 0.9, 1.4, 21, .07, 300, .4]
        // const sizes = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        // const margin = 1e6

        // console.log({ underlyingPrices, sizes, margin })
        let activeMarkets = 0
        for (let i = 0; i < marketInfo.length; i++) {
            if (marketInfo[i].active) activeMarkets++
        }

        nonce = await provider.getTransactionCount(signer.address)

        // if maker has accumaleted too much margin, transfer it to taker kek
        // keep only 100k margin per market
        let diff = margin - 1e5 * activeMarkets
        // let diff = 276533.75526
        if (!dryRun && diff > 30000) {
            console.log(`adding ${diff} margin to taker account`)
            diff = ethers.utils.parseUnits(diff.toFixed(6).toString(), 6)
            await exchange.marginAccount.connect(signer).removeMargin(0, diff, { nonce: nonce++ })
            // assume infinite approval was already done
            await exchange.marginAccount.connect(signer).addMarginFor(0, diff, config.marketMaker.taker, { gasLimit: 1e6, nonce: nonce++ })
            // await exchange.marginAccount.connect(signer).addMarginFor(0, diff, config.marketMaker.taker, { nonce: nonce++ })
        }

        let orders = []
        // for (let i = 1; i < 2; i++) {
        for (let i = 0; i < marketInfo.length; i++) {
            if (!marketInfo[i].active) continue
            orders = orders.concat(await runForMarket(i, underlyingPrices[i], sizes[i], margin / activeMarkets)).filter(o => o)
        }
        console.log(`placing ${orders.length} orders...`)
        // if (orders.length) console.log(prettyPrint(orders, marketInfo))
        if (!dryRun && orders.length) await exchange.placeOrders(signer, orders, { nonce })
    } catch (e) {
        if (e && e.error) {
            const err = findError(e.error.toString())
            if (err) console.error(`encountered error`, err)
            else console.error(e)
            // fail silently because order cancel only fails when it was already matched
        } else {
            console.error(e)
        }
    }

    // Schedule the next update
    setTimeout(marketMaker, updateFrequency)
};

async function runForMarket(market, underlyingPrice, size, margin) {
    let { x, spread } = marketInfo[market]
    x = parseFloat((randomFloat(.9, 1.1) * x).toFixed(3))
    try {
        let { orders, bids, asks } = await exchange.getTraderBidsAndAsks(signer.address, market)
        // console.log(bids.length, asks.length)
        // console.log({ bids, asks, underlyingPrice })

        // we will always cater in +-x% of underlying price and close rest of the orders
        let lowerBound = underlyingPrice * (1-x)
        let upperBound = underlyingPrice - spread/2
        if (lowerBound >= upperBound) {
            console.error(`fix the config for market=${market}`, { underlyingPrice, x, spread })
            return []
        }
        const validBids = getOrdersWithinBounds(bids, lowerBound, upperBound)

        lowerBound = underlyingPrice + spread/2
        upperBound = underlyingPrice * (1+x)
        if (lowerBound >= upperBound) {
            console.error(`fix the config for market=${market}`, { underlyingPrice, x, spread })
            return []
        }
        const validAsks = getOrdersWithinBounds(asks, lowerBound, upperBound)
        // console.log({ validBids, validAsks })

        // cancel long orders that are </> than +-x% of underlying price
        let idsToClose = bids.filter(bid => !validBids.includes(bid) || bid.reduceOnly).map(bid => bid.id.toLowerCase()).concat(
            asks.filter(ask => !validAsks.includes(ask) || ask.reduceOnly).map(bid => bid.id.toLowerCase())
        )
        if (!dryRun && idsToClose.length) {
            const ordersToClose = toRawOrders(signer.address, orders.filter(order => idsToClose.includes(order.OrderId.toLowerCase()))) // cancel reduce only orders as well because that becomes problematic
            console.log(`Cancelling ${ordersToClose.length} orders`)
            const txs = await exchange.cancelOrders(signer, ordersToClose, { nonce })
            nonce += txs.length
        }
        return decideStrategy(market, bids, asks, underlyingPrice, size, margin)
    } catch (error) {
        console.error('Error in marketMaker function:', error);
    }
}

const decideStrategy = (market, bids, asks, underlyingPrice, size, margin) => {
    let { x, spread, minOrderSize, maker: { baseLiquidityInMarket } } = marketInfo[market]
    const leverage = size == 0 ? 0 : (Math.abs(size) * underlyingPrice) / margin

    const shortLB = underlyingPrice + spread/2
    const shortUB = underlyingPrice * (1+x)
    // sum size for all orders
    const shortOpenSize = getOpenSize(asks)

    const longLB = underlyingPrice * (1-x)
    const longUB = underlyingPrice - spread/2
    const longOpenSize = getOpenSize(bids)
    // console.log({ market, leverage, size, shortOpenSize, longOpenSize, shortUB, shortLB, underlyingPrice, longUB, longLB })

    let shouldLong = true
    let shouldShort = true
    let reduceOnly = false

    // If leverage is greater than the threshold, place orders to reduce open position and cancel opposite orders
    if (Math.abs(leverage) > maxLeverage) {
        console.log(`Leverage=${leverage} is above threshold`)
        baseLiquidityInMarket = Math.abs(size) // reduce leverage to 3/4 of current
        reduceOnly = true // so that these orders don't use margin
        if (size > 0) { // place only short orders
            shouldLong = false
        } else if (size < 0) { // place only long orders
            shouldShort = false
        }
    }

    shouldShort = shouldShort && shortOpenSize + minOrderSize < baseLiquidityInMarket
    shouldLong = shouldLong && longOpenSize + minOrderSize < baseLiquidityInMarket
    // console.log({ baseLiquidityInMarket, shouldLong, shouldShort })
    let orders = []
    if (shouldShort) {
        orders = buildOrders(shortLB, shortUB, "SHORT", baseLiquidityInMarket - shortOpenSize, reduceOnly, market, minOrderSize)
        // orders = buildOrders(shortLB, asks.length ? asks[0].price : shortUB, "SHORT", baseLiquidityInMarket - shortOpenSize, reduceOnly, market, minOrderSize)
    }
    if (shouldLong) {
        orders = orders.concat(buildOrders(longLB, longUB, "LONG", baseLiquidityInMarket - longOpenSize, reduceOnly, market, minOrderSize))
        // orders = orders.concat(buildOrders(bids.length ? bids[0].price : longLB, longUB, "LONG", baseLiquidityInMarket - longOpenSize, reduceOnly, market, minOrderSize))
    }
    return orders
}

const buildOrders = (lower, upper, type, totalSize, reduceOnly, market) => {
    const { minOrderSize, toFixed, maker: { maxOrderSize } } = marketInfo[market]
    // for this run maxOrderSize will be a random number b/w .8 to 1 of maxOrderSize
    let _maxOrderSize = parseFloat((randomFloat(.8, 1) * maxOrderSize).toFixed(toFixed))
    // e.g. we will place 5 orders at 20% intervals
    const interval = (upper - lower) / numOrders
    // console.log({ upper, lower, interval })
    let sizes = generateRandomArray(numOrders, totalSize, minOrderSize, _maxOrderSize, toFixed)
    // console.log({ sizes })
    if (type == "SHORT") sizes = sizes.map(size => -size)
    const orders = []
    for (let i = 0; i < sizes.length; i++) {
        let price = type == "LONG" ? upper - i * interval : upper - (i+1) * interval
        price = parseFloat(price.toFixed(4))
        // console.log({ price, size: sizes[i] })
        orders.push(exchange.buildOrderObj(signer.address, market, sizes[i], price, reduceOnly))
    }
    return orders
}

// generate a random float within a min and max range
function randomFloat(min, max) {
    return Math.random() * (Math.abs(max) - Math.abs(min)) + Math.abs(min);
}

// write a function to generate an array of `numOrders` length such that the elements are randomly generated and sum to `totalSize`
// also each element should within +- 10% of the element before and after it. and no element is 0.
function generateRandomArray(numOrders, totalSize, minOrderSize, maxOrderSize, toFixed) {
    let result = [];
    let sum = 0;
    // console.log({ totalSize })
    for (let i = 0; i < numOrders - 1; i++) {
        const remaining = totalSize - sum
        if (remaining < minOrderSize) break;
        let current = Math.min(randomFloat(minOrderSize, remaining), maxOrderSize)
        // console.log({ current, totalSize, sum, remaining })
        if (current >= minOrderSize) {
            result.push(current);
            sum += current;
        }
    }

    // Add the last element so that the sum equals totalSize
    const remaining = Math.min(totalSize - sum, maxOrderSize)
    // console.log({ remaining, totalSize, sum, maxOrderSize })
    if (remaining >= minOrderSize) result.push(totalSize - sum)
    result = result.map(size => parseFloat(size.toFixed(toFixed)))
    // console.log({ result })
    return shuffle(result)
}

function shuffle(array) {
    let currentIndex = array.length,  randomIndex;

    // While there remain elements to shuffle.
    while (currentIndex != 0) {

      // Pick a remaining element.
      randomIndex = Math.floor(Math.random() * currentIndex);
      currentIndex--;

      // And swap it with the current element.
      [array[currentIndex], array[randomIndex]] = [
        array[randomIndex], array[currentIndex]];
    }

    return array;
}

// Start the market-making algorithm
marketMaker();
