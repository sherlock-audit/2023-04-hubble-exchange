const csv = require('csv-parser')
const utils = require('../../test/utils')
const fs = require('fs')
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const { getVammJS } = require('../../dist/VammJS')
const {
    constants: { _1e6, _1e18 },
    setupContracts,
    setupRestrictedTestToken,
    setupAmm,
    addMargin,
    bnToFloat
} = utils

/**
 * Deploying ETH amm in active mode with $2m liquidity (1k eth at $1k) added
 * Deploying BTC amm in ignition mode  with $2m liquidity (30 BTC at $35k) commited.
 * Unbond period for both is 5mins
 *
 * After deployment
 * governance - signers[0]
 * maker - signers[9]
 * signers[1], signers[2] have 1000 vUSD and 200 avax each
 * call btcAMM.liftOff() with governance to put AMM in active mode
 */

async function main() {
    const liquidityTarget = 5e6
    const days = 31
    const minutes = days * 1440

    signers = await ethers.getSigners()
    governance = signers[0].address
    trader = signers[1]
    maker2 = signers[10]

    await setupContracts({ governance, setupAMM: false })
    const avax = await setupRestrictedTestToken('Avalanche', 'AVAX', 8)

    // 3. AMMs
    console.log('setup AMMs...')
    const initialRate = 109.8 // avax rate on Jan 1
    const ammOptions = {
        initialRate,
        initialLiquidity: liquidityTarget / (2 * initialRate),
        fee: 5000000, // .05%
        ammState: 2 // Active
    }
    ;({ amm, vamm } = await setupAmm(
        governance,
        [ 'AVAX-PERP', avax.address, oracle.address, 0 ],
        Object.assign(ammOptions, { index: 0 })
    ))

    // maker2 adds liq
    const makerLiqTarget = 10000
    await addMargin(maker2, _1e6.mul(makerLiqTarget))
    await clearingHouse.connect(maker2).addLiquidity(0, ethers.utils.parseUnits((makerLiqTarget / (2 * initialRate)).toString(), 18), 0)
    _maker2 = await amm.makers(maker2.address)
    const maker2Vars = {
        dToken: bnToFloat(_maker2.dToken, 18),
        vUSD: bnToFloat(_maker2.vUSD, 6),
        vAsset: bnToFloat(_maker2.vAsset, 18)
    }
    console.log({ maker2Vars })

    // trader adds margin
    const initialVusdAmount = _1e6.mul(_1e6).mul(10) // $10m
    await addMargin(trader, initialVusdAmount)

    vammJS = await getVammJS(vamm)

    let markPrice = initialRate
    console.log({ initialRate, markPrice: vammJS.markPrice() })

    const trades = (await parseCsv(`${__dirname}/avax_perp_minutely.csv`)).slice(0, minutes)
    console.log(`begin trading until ${trades[trades.length-1].time}...`)

    const data = []
    let numTrades = 0
    let volume = 0
    let slippage = 0

    try {
        for (let i = 0; i < trades.length; i++) {
            const epoch = trades[i].time
            const openPrice = parseFloat(trades[i].price_open)
            const closePrice = parseFloat(trades[i].price_close)
            const highPrice = parseFloat(trades[i].price_high)
            const lowPrice = parseFloat(trades[i].price_low)

            if (closePrice > openPrice) {
                target = [openPrice, lowPrice, highPrice, closePrice]
            } else {
                target = [openPrice, highPrice, lowPrice, closePrice]
            }
            // target = [closePrice]
            // target = [openPrice, closePrice]
            console.log({ epoch, price_scale: vammJS.vars().price_scale, markPrice, target })

            let _slippage = 0
            let _numTrades = 0
            let size
            for (let j = 0; j < target.length; j++) {
                size = getOptimalTradeSize(markPrice, target[j])

                if (size == 0) continue
                quoteAsset = executeTrade(size)

                const avgPrice = quoteAsset / Math.abs(size)
                // console.log({ size, quoteAsset, avgPrice })
                _slippage += (Math.abs(avgPrice - markPrice) * 100 / markPrice)
                markPrice = vammJS.markPrice()

                volume += quoteAsset
                _numTrades++
            }

            slippage += _slippage // we will divide by numTrades eventually
            if (_numTrades) {
                _slippage /= _numTrades
            }

            let { position, openNotional, unrealizedPnl } = vammJS.get_maker_position(maker2Vars.dToken, maker2Vars.vUSD, maker2Vars.vAsset, maker2Vars.dToken)
            const apr = (unrealizedPnl * 1440 * 36500) / (makerLiqTarget * (i+1))

            // depth = avg of 50bps movement in both directions
            const depth = markPrice * (
                Math.abs(getOptimalTradeSize(markPrice, markPrice * 1.005))
                + Math.abs(getOptimalTradeSize(markPrice, markPrice * 0.995))
            ) / 2

            data.push({
                epoch: epoch.slice(8, 16),
                closePrice,
                markPrice,
                depth,
                volume: quoteAsset,
                slippage: _slippage,
                position,
                openNotional,
                unrealizedPnl,
                apr
            })
            numTrades += _numTrades
        }
    } catch(e) {
        console.log(e)
    } finally {
        console.log({ numTrades, volume, avg_slippage: slippage / numTrades })
        const csvWriter = createCsvWriter({
            path: `${__dirname}/${liquidityTarget/1e6}m-${days}-days-v2.csv`,
            header: [
                {id: 'epoch', title: 'epoch'},
                {id: 'unrealizedPnl', title: 'unrealizedPnl'},
                {id: 'apr', title: 'apr'},
                {id: 'volume', title: 'volume'},
                {id: 'closePrice', title: 'closePrice'},
                {id: 'markPrice', title: 'markPrice'},
                {id: 'depth', title: 'depth'},
                {id: 'slippage', title: 'slippage'},
                {id: 'position', title: 'position'},
                {id: 'openNotional', title: 'openNotional'},
            ]
        })
        await csvWriter.writeRecords(data)
    }
}

function getOptimalTradeSize(markPrice, targetPrice) {
    // console.log({ markPrice, targetPrice })
    let size = 0
    let unitTrade = 5
    const convergenceMultiple = 1000

    if (markPrice < targetPrice) { // Long
        // start with unitTrade and increment until last price is in 0.1% range of targetPrice
        while (markPrice < targetPrice) {
            size += unitTrade
            ;([ quote, _, markPrice ] = vammJS.get_dx(size))
            // console.log({ size, predicted_mp: markPrice, targetPrice })
            if (markPrice > targetPrice * 1.05) {
                throw `markPrice exceeded the targetPrice by far` // high slippage
            }
            if (size > unitTrade * convergenceMultiple) throw 'size convergence failed'
        }
    } else if (markPrice > targetPrice) { // Short
        while (markPrice > targetPrice) {
            size += unitTrade
            ;([ quote, _, markPrice ] = vammJS.get_dy(size))
            // console.log({ size: -size, predicted_mp: markPrice, targetPrice })
            if (markPrice < targetPrice * 0.95) {
                throw `markPrice exceeded the targetPrice by far` // high slippage
            }
            if (size > unitTrade * convergenceMultiple) throw `size convergence failed`
        }
        size = -size
    }
    return size
}

function executeTrade(size) {
    console.log(`executeTrade size=${size}...`)
    if (size > 0) {
        return vammJS.long(size, 1e10)
    } else if (size < 0) {
        return vammJS.short(Math.abs(size), 0)
    }
}

function parseCsv(path) {
    const results = []
    return new Promise(async (resolve, reject) => {
        fs.createReadStream(path)
        .pipe(csv())
        .on('data', (data) => {
            results.push(data)
        })
        .on('end', async () => {
            try {
                resolve(results)
            } catch(e) {
                reject(e)
            }
        });
    })
}

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
