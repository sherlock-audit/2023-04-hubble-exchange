const csv = require('csv-parser')
const utils = require('../../test/utils')
const fs = require('fs')
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const {
    constants: { _1e6, _1e18 },
    BigNumber,
    setupContracts,
    setupRestrictedTestToken,
    parseRawEvent2,
    setupAmm,
    addMargin,
    bnToFloat
} = utils
const _1e8 = BigNumber.from(10).pow(8)

// VAMM
const N_COINS = 2
const A_MULTIPLIER = 10000
const MIN_A = (N_COINS**N_COINS) * A_MULTIPLIER / 10
const MAX_A = (N_COINS**N_COINS) * A_MULTIPLIER * 100000
const MIN_GAMMA = 10**-8
const MAX_GAMMA = 2 * (10 ** -2)
const MIN_D = 0.1;
const MAX_D = (10 ** 15)

const A = 400000
const gamma = 0.000145
const midFee = 0.0005

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
    const liquidityTarget = 10e6
    const minutes = 5

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

    // trader adds margin
    const initialVusdAmount = _1e6.mul(_1e6).mul(10) // $10m
    await addMargin(trader, initialVusdAmount)

    let markPrice = initialRate
    let priceScale = initialRate
    let D = bnToFloat(await vamm.D({gasLimit: 1e6}), 18)
    let balances = [
        bnToFloat(await vamm.balances(0, {gasLimit: 1e6})),
        bnToFloat(await vamm.balances(1, {gasLimit: 1e6}), 18),
    ]

    // const trades = (await parseCsv(`${__dirname}/avax_perp_minutely.csv`)).slice(4, 5)
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

            // if (closePrice > openPrice) {
            //     target = [openPrice, lowPrice, highPrice, closePrice]
            // } else {
            //     target = [openPrice, highPrice, lowPrice, closePrice]
            // }
            target = [closePrice]
            // target = [openPrice, closePrice]
            console.log({ epoch, priceScale, markPrice, target })

            let _slippage = 0
            let _numTrades = 0
            let size
            for (let j = 0; j < target.length; j++) {
                size = getOptimalTradeSize(markPrice, target[j], balances, D, priceScale, A, gamma, midFee)

                if (size == 0) continue
                ;({ quoteAsset, priceScale, D, balances } = await executeTrade(size))

                const avgPrice = quoteAsset / Math.abs(size)
                _slippage += (Math.abs(avgPrice - markPrice) * 100 / markPrice)
                markPrice = calcMarkPrice(balances[0], balances[1] * priceScale, A, gamma, D, priceScale)

                volume += quoteAsset
                _numTrades++
            }

            slippage += _slippage // we will divide by numTrades eventually
            if (_numTrades) {
                _slippage /= _numTrades
            }

            let { position, openNotional, unrealizedPnl } = await hubbleViewer.getMakerPositionAndUnrealizedPnl(maker2.address, 0)
            unrealizedPnl = bnToFloat(unrealizedPnl)
            const apr = (unrealizedPnl * 1440 * 36500) / (makerLiqTarget * (i+1))

            // depth
            // const depth = markPrice * (
            //     Math.abs(getOptimalTradeSize(markPrice, markPrice * 1.005, balances, D, priceScale, A, gamma, midFee))
            //     + Math.abs(getOptimalTradeSize(markPrice, markPrice * 0.995, balances, D, priceScale, A, gamma, midFee))
            // ) / 2

            data.push({
                closePrice,
                markPrice,
                depth: 0,
                volume: quoteAsset,
                slippage: _slippage,
                position: bnToFloat(position, 18),
                openNotional: bnToFloat(openNotional),
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
            path: `${__dirname}/${liquidityTarget/1e6}m-${minutes}-v1.csv`,
            header: [
                {id: 'volume', title: 'volume'},
                {id: 'closePrice', title: 'closePrice'},
                {id: 'markPrice', title: 'markPrice'},
                {id: 'depth', title: 'depth'},
                {id: 'slippage', title: 'slippage'},
                {id: 'position', title: 'position'},
                {id: 'openNotional', title: 'openNotional'},
                {id: 'unrealizedPnl', title: 'unrealizedPnl'},
                {id: 'apr', title: 'apr'},
            ]
        })
        await csvWriter.writeRecords(data)
    }
}

function getOptimalTradeSize(markPrice, targetPrice, balances, D, priceScale, A, gamma, midFee) {
    // console.log({ markPrice, targetPrice, balances, D, priceScale, A, gamma, midFee })
    let size = 0
    let unitTrade = 5
    const convergenceMultiple = 1000

    if (markPrice < targetPrice) { // Long
        // start with unitTrade and increment until last price is in 0.1% range of targetPrice
        while (markPrice < targetPrice) {
            size += unitTrade
            ;([ quote, _, markPrice ] = get_dx(0, 1, size, balances, D, priceScale, A, gamma, midFee))
            console.log({ size, predicted_mp: markPrice, targetPrice })
            if (markPrice > targetPrice * 1.05) {
                throw `markPrice exceeded the targetPrice by far` // high slippage
            }
            if (size > unitTrade * convergenceMultiple) throw 'size convergence failed'
        }
    } else if (markPrice > targetPrice) { // Short
        while (markPrice > targetPrice) {
            size += unitTrade
            ;([ quote, _, markPrice ] = get_dy(1, 0, size, balances, D, priceScale, A, gamma, midFee))
            console.log({ size: -size, predicted_mp: markPrice, targetPrice })
            if (markPrice < targetPrice * 0.95) {
                throw `markPrice exceeded the targetPrice by far` // high slippage
            }
            if (size > unitTrade * convergenceMultiple) throw `size convergence failed`
        }
        size = -size
    }
    return size
}

async function executeTrade(size) {
    console.log(`executeTrade size=${size}...`)
    const tx = await clearingHouse.connect(trader).openPosition(
        0,
        ethers.utils.parseUnits(size.toString(), 18),
        size > 0 ? _1e18 : 0
    )
    const { events } = await tx.wait()
    const positionModifiedEvent = await parseRawEvent2(events, clearingHouse, 'PositionModified')
    // const swapEvent = parseRawEvent2(events, amm, 'Swap')
    const { args } = parseRawEvent2(events, vamm, 'TokenExchange')
    return {
        quoteAsset: bnToFloat(positionModifiedEvent.args.quoteAsset),
        priceScale: bnToFloat(args.price_scale, 18),
        D: bnToFloat(args.D, 18),
        balances: [
            bnToFloat(args.balances[0]),
            bnToFloat(args.balances[1], 18),
        ],
    }
}

function get_dy(i, j, dx, balances, D, priceScale, A, gamma, midFee) {
    if (i == j) {
        throw Error('same input and output coin')
    }
    if (i >= N_COINS) {
        throw Error('i coin index out of range')
    }
    if (j >= N_COINS) {
        throw Error('j coin index out of range')
    }
    if (dx <= 0) {
        throw Error('can only exchange positive coins')
    }

    let xp = balances.slice()

    xp[i] = xp[i] + dx;
    xp = [xp[0], xp[1] * priceScale];

    const y = newton_y(A, gamma, xp, D, j)
    let dy = xp[j] - y - (10 ** -18);

    if (j > 0) {
        dy = dy / priceScale;
    }

    const fee = midFee * dy;
    dy -= fee;

    xp[j] -= dy
    if (j > 0) {
        xp[j] = xp[j] * priceScale;
    }

    const DNew = newton_D(A, gamma, xp)
    const markPrice = calcMarkPrice(xp[0], xp[1], A, gamma, DNew, priceScale)

    return [dy, fee, markPrice];
}

function get_dx(i, j, dy, balances, D, priceScale, A, gamma, midFee) {
    if (i == j) {
        throw Error('same input and output coin')
    }
    if (i >= N_COINS) {
        throw Error('i coin index out of range')
    }
    if (j >= N_COINS) {
        throw Error('j coin index out of range')
    }
    if (dy <= 0) {
        throw Error('can only exchange positive coins')
    }

    let xp = balances.slice()

    xp[j] = xp[j] - dy
    xp = [xp[0], xp[1] * priceScale]
    const x = newton_y(A, gamma, xp, D, i)

    let dx = x - xp[i] + 10**-18
    if (i > 0) {
        dx = dx / priceScale
    }

    const fee = midFee * dx
    dx += fee

    xp[i] += dx
    if (i > 0) {
        xp[i] = xp[i] * priceScale;
    }

    const DNew = newton_D(A, gamma, xp)
    const markPrice = calcMarkPrice(xp[0], xp[1], A, gamma, DNew, priceScale)

    return [dx, fee, markPrice]
}

function get_D(A, gamma, balances, priceScale) {
    const xp = balances.slice()
    xp[1] = xp[1] * priceScale;
    const D = newton_D(A, gamma, xp)
    return D
}

function newton_y(ANN, gamma, x, D, i) {
    if ((ANN <= MIN_A - 1) || (ANN >= MAX_A + 1)) {
        throw Error('unsafe values for A')
    }
    if ((gamma <= MIN_GAMMA - (10**-18)) || (gamma >= MAX_GAMMA + (10**-18))) {
        throw Error('unsafe values for gamma')
    }
    if ((D <= MIN_D - (10**-18)) || (D >= MAX_D + (10**-18))) {
        throw Error('unsafe values for D')
    }

    let xj = x[1 - i];
    let y = D ** 2 / (xj * (N_COINS ** 2));
    let k0_i = (N_COINS * xj) / D;
    if (k0_i <= (10 ** -2) * N_COINS - (10 ** -18) || (k0_i >= (10 ** 2) * N_COINS + (10 ** -18))) {
        throw Error('unsafe values for x[i]');
    }
    let convergenceLimit = Math.max(Math.max(xj, D), 0.01);
    for (let n = 0; n < 255; n++) {
        const yPrev = y;
        let k0 = (k0_i * y * N_COINS) / D;
        let s = xj + y;
        let g1k0 = gamma + 1;
        if (g1k0 > k0) {
            g1k0 = g1k0 - k0 + (10 ** -18);
        }
        else {
            g1k0 = k0 - g1k0 + (10 ** -18);
        }
        let mul1 = (D / gamma) * (g1k0 / gamma) * g1k0 * A_MULTIPLIER / ANN;
        let mul2 = 1 + (2 * k0 / g1k0);
        let yfprime = y + (s * mul2 ) + (mul1 );
        let dyfprime = D * mul2;
        if (yfprime < dyfprime) {
            y = yPrev / 2;
            continue;
        }
        else {
            yfprime -= dyfprime;
        }

        let fprime = yfprime / y;
        let yMinus = mul1 / fprime;
        let yPlus = ((yfprime + D) / fprime) + (yMinus / k0);
        yMinus += s / fprime;
        if (yPlus < yMinus) {
            y = yPrev / 2;
        }
        else {
            y = yPlus - yMinus;
        }

        let diff = 0;
        if (y > yPrev) {
            diff = y - yPrev;
        }
        else {
            diff = yPrev - y;
        }

        if ((diff*10**14) < Math.max(convergenceLimit, y)) {
            let frac = y / D;
            if ((frac <= (10 ** -2) - (10 ** -18)) || (frac >= (10 ** 2) + (10 ** -18))) {
                throw Error('unsafe value for y');
            }
            return y;
        }
    }
    throw Error('did not converge');
}

function newton_D(ANN, gamma, x_unsorted) {
    if ((ANN <= MIN_A - 1) || (ANN >= MAX_A + 1)) {
        throw Error('unsafe values for A')
    }

    const wei = 1e-18
    if ((gamma <= MIN_GAMMA - wei) || (gamma >= MAX_GAMMA + wei)) {
        throw Error('unsafe values for gamma')
    }

    const x = x_unsorted.slice().sort().reverse()

    if (x[0] <= (1e-9 - wei) || x[0] >= (1e15 + wei)) {
        throw Error('unsafe values for x[0]')
    }

    if (x[1] / x[0] <= (1e-4 - wei)) {
        throw Error('unsafe values for x[1]')
    }

    let D = N_COINS * geometricMean(x)
    const S = x[0] + x[1]

    for (let n = 0; n < 255; n++) {
        let DPrev = D

        const K0 = x[0] * x[1] * N_COINS**2 / D**2
        let g1k0 = gamma + 1

        if (g1k0 > K0) {
            g1k0 = g1k0 - K0 + wei
        } else {
            g1k0 = K0 - g1k0 + wei
        }

        const mul1 = (D / gamma) * (g1k0 / gamma) * g1k0 * A_MULTIPLIER / ANN;
        const mul2 = 2 * N_COINS * K0 / g1k0
        const negFprime = (S + S * mul2) + mul1 * N_COINS / K0 - mul2 * D

        const DPlus = D * (negFprime + S) / negFprime
        let DMinus = D**2 / negFprime
        DMinus -= D * (mul1 / negFprime) * (K0 - 1) / K0

        if (DPlus > DMinus) {
            D = DPlus - DMinus
        } else {
            D = (DMinus - DPlus) / 2
        }

        const diff = Math.abs(D - DPrev)
        if ((diff*10**14) < Math.max(1e-2, D)) {
            for (let i=0; i < N_COINS; i++) {
                const frac = x[i] / D;
                if (frac <= (1e-2 - wei) || frac >= (1e2 + wei)) {
                    throw Error(`unsafe value for x[${i}]`);
                }
            }
            return D;
        }
    }
    throw Error('did not converge');
}

function calcMarkPrice(x, y, A, gamma, D, priceScale) {
    const DSquare = D**2
    const K0 = 4 * x * y / DSquare
    const g1k = (A * gamma**2) / (gamma + 1 - K0)**2 / A_MULTIPLIER
    const K = g1k * K0
    const P = g1k * (1 + 2 * K0 / (gamma + 1 - K0))
    const Q = 4 * x / DSquare
    const R = 4 * y / DSquare

    const g2k = D * (x + y) - DSquare
    const numerator = y + P * R * g2k + K * D
    const denominator = P * Q * g2k + K * D + x

    const yPrime = - numerator / denominator
    // markPrice = priceScale * (dx / dy)
    return Math.abs(priceScale/yPrime)
}

function geometricMean(x) {
    return Math.sqrt(x[0]*x[1])
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
