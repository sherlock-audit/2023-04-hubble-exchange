const utils = require('../../test/utils')
const { addMargin } = require('../deploy/deployUtils')
const { Exchange } = require('../market-maker/exchange')

const {
    constants: { _1e6 },
    setupContracts,
    generateConfig,
    getTxOptions,
    sleep,
    txOptions
} = utils

const gasLimit = 5e6

const config = {
    OrderBook: '0x0300000000000000000000000000000000000000',
    MarginAccount: '0x0300000000000000000000000000000000000001',
    ClearingHouse: '0x0300000000000000000000000000000000000002',
    Bibliophile: '0x0300000000000000000000000000000000000003'
}

/**
 * After deployment
 * governance - signers[0]
 * signers[1], signers[2] have 1000 vUSD each
 */

async function main(setBiblioPhile) {
    signers = await ethers.getSigners()
    governance = signers[0].address
    ;([, alice, bob] = signers)

    // 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
    // console.log(signers[0].address, signers[1].address, signers[2].address)

    txOptions.nonce = await signers[0].getTransactionCount()
    // this is a hack for an interesting use-case
    // when we deploy an implementation contract (tx1) and subsequently the TransparentProxy (tx2), the gas estimation for tx2 might fail because the tx1 is not yet mined
    // however, if we pass the gasLimit here, the estimation is skipped and nonce makes sure that tx1 and then tx2 is mined
    txOptions.gasLimit = gasLimit

    const { orderBook, clearingHouse, marginAccount } =  await setupContracts({
        governance,
        restrictedVUSD: false,
        genesisProxies: true,
        mockOrderBook: false,
        testClearingHouse: false,
        setupAMM: false
    })

    // whitelist evm address for order execution transactions
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x4Cf2eD3665F6bFA95cE6A11CFDb7A2EF5FC1C7E4'), true, getTxOptions())
    if (setBiblioPhile) {
        await clearingHouse.setBibliophile(config.Bibliophile, getTxOptions())
        await orderBook.setBibliophile(config.Bibliophile, getTxOptions())
        await marginAccount.setBibliophile(config.Bibliophile, getTxOptions())
    }

    await sleep(3)
    await addMargin(alice, _1e6.mul(40000), gasLimit)
    await addMargin(bob, _1e6.mul(40000), gasLimit)

    // console.log(JSON.stringify(await generateConfig(leaderboard.address, marginAccountHelper.address), null, 0))
}

async function setupAMM(name, initialRate, oracleAddress, slowMode=true) {
    const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    const tok = await ERC20Mintable.deploy(`${name}-tok`, `${name}-tok`, 18, getTxOptions())
    governance = signers[0].address
    ;({ amm } = await _setupAmm(
        governance,
        [ name, tok.address, oracleAddress ],
        {
            initialRate,
            testAmm: false,
            whitelist: true,
            oracleAddress,
            minSize: utils.BigNumber.from(10).pow(17) // 0.1
        },
        slowMode
    ))
    // console.log('deployed', name, amm.address)
}

async function _setupAmm(governance, args, ammOptions, slowMode) {
    const { initialRate, testAmm, whitelist, minSize, oracleAddress  } = ammOptions
    const AMM = await ethers.getContractFactory('AMM')
    const TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')

    let admin = await ethers.provider.getStorageAt(config.OrderBook, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103')

    const ammImpl = await AMM.deploy(config.ClearingHouse, getTxOptions())
    let constructorArguments = [
        ammImpl.address,
        ethers.utils.hexStripZeros(admin),
        ammImpl.interface.encodeFunctionData('initialize', args.concat([ minSize, governance ]))
    ]
    const ammProxy = await TransparentUpgradeableProxy.deploy(...constructorArguments, getTxOptions())
    await ammProxy.deployTransaction.wait()

    const amm = await ethers.getContractAt(testAmm ? 'TestAmm' : 'AMM', ammProxy.address)

    if (slowMode) {
        await sleep(3) // if the above txs aren't mined, read calls to amm fail
    }

    if (initialRate) {
        // amm.liftOff() needs the price for the underlying to be set
        // set index price within price spread
        const oracle = await ethers.getContractAt('TestOracle', oracleAddress)
        const underlyingAsset = await amm.underlyingAsset()
        await oracle.setUnderlyingTwapPrice(underlyingAsset, ethers.utils.parseUnits(initialRate.toString(), 6), getTxOptions())
        await oracle.setUnderlyingPrice(underlyingAsset, ethers.utils.parseUnits(initialRate.toString(), 6), getTxOptions())
    }

    if (whitelist) {
        const clearingHouse = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
        const orderBook = await ethers.getContractAt('OrderBook', config.OrderBook)
        await clearingHouse.whitelistAmm(amm.address, getTxOptions())
        await orderBook.initializeMinSize(minSize, getTxOptions())
    }

    return { amm }
}

async function amms() {
    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    const ma = await ethers.getContractAt('MarginAccount', config.MarginAccount)
    console.log(await ma.oracle(), await ch.getAmmsLength(), await ch.getAMMs())
}

async function getAvailableMargin() {
    signers = await ethers.getSigners()
    ;([, alice, bob] = signers)
    const ma = await ethers.getContractAt('MarginAccount', config.MarginAccount)
    console.log(await ma.getAvailableMargin(alice.address))
    console.log(await ma.getAvailableMargin(bob.address))
    console.log(await ma.margin(0, alice.address))
    console.log(await ma.margin(0, bob.address))
}

async function runAnalytics() {
    signers = await ethers.getSigners()
    ;([, alice, bob] = signers)

    txOptions.nonce = await signers[0].getTransactionCount()
    txOptions.gasLimit = gasLimit

    // const orderBook = await ethers.getContractAt('OrderBook', config.OrderBook)
    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    const ma = await ethers.getContractAt('MarginAccount', config.MarginAccount)
    const oracle = await ma.oracle()

    const amms = await ch.getAmmsLength()
    const exchange = new Exchange(ethers.provider)

    // deploy 3 AMMS
    for (let i = amms.toNumber(); i < 1; i++) {
        const marketId = i
        console.log(`deploying new amm at id=${marketId}`)
        await setupAMM(`Market-${marketId}-Perp`, (marketId+1) * 10, oracle, false)
    }
    await sleep(3)

    const marketId = 0
    for (let i = 1; i <= 10; i++) {
        // place #i orders at once
        const orders = []
        for (let j = 0; j < i; j++) {
            orders.push(exchange.buildOrderObj(alice.address, marketId, (marketId+1) * 10, (marketId+1) * 10))
        }
        let tx1 = await (await exchange.placeOrders(alice, false, orders)).wait()
        // console.log({ blockNumber: tx1.blockNumber })

        // cancel #i orders at once
        const tx2 = await (await exchange.cancelOrders(alice, orders)).wait()
        // console.log({ blockNumber: tx2.blockNumber })

        console.log({
            numOrders: i,
            place: { gasUsed: tx1.gasUsed.toNumber(), cost: `$${gasToPrice(tx1.gasUsed.toNumber())}` },
            cancel: { gasUsed: tx2.gasUsed.toNumber(), cost: `$${gasToPrice(tx2.gasUsed.toNumber())}` }
        })
    }
}

function gasToPrice(gas) {
    return gas * 30 / 1e9
}

async function placeOrder(signer, ammIndex, baseAssetQuantity, price) {
    let order = exchange.buildOrderObj(signer.address, ammIndex, baseAssetQuantity, price)
    const tx1 = await (await exchange.placeOrders(signer, false, [order])).wait()
    return { order, gasUsed: tx1.gasUsed.toNumber(), blockNumber: tx1.blockNumber }
    // const orderPlacedEvent = tx1.events.find(e => e.event === 'OrderPlaced')
    // return { orderHash: orderPlacedEvent.args.orderHash, gasUsed: tx1.gasUsed.toNumber(), blockNumber: tx1.blockNumber }
}

main(true /* setBiblioPhile */)
// runAnalytics()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});

/** Results
{
  numOrders: 1,
  place: { gasUsed: 174301, cost: '$0.00522903' },
  cancel: { gasUsed: 74476, cost: '$0.00223428' }
}
{
  numOrders: 2,
  place: { gasUsed: 252455, cost: '$0.00757365' },
  cancel: { gasUsed: 95374, cost: '$0.00286122' }
}
{
  numOrders: 3,
  place: { gasUsed: 330601, cost: '$0.00991803' },
  cancel: { gasUsed: 116262, cost: '$0.00348786' }
}
{
  numOrders: 4,
  place: { gasUsed: 408776, cost: '$0.01226328' },
  cancel: { gasUsed: 137178, cost: '$0.00411534' }
}
{
  numOrders: 5,
  place: { gasUsed: 486942, cost: '$0.01460826' },
  cancel: { gasUsed: 158084, cost: '$0.00474252' }
}
{
  numOrders: 6,
  place: { gasUsed: 565110, cost: '$0.0169533' },
  cancel: { gasUsed: 178991, cost: '$0.00536973' }
}
{
  numOrders: 7,
  place: { gasUsed: 643283, cost: '$0.01929849' },
  cancel: { gasUsed: 199901, cost: '$0.00599703' }
}
{
  numOrders: 8,
  place: { gasUsed: 721461, cost: '$0.02164383' },
  cancel: { gasUsed: 220815, cost: '$0.00662445' }
}
{
  numOrders: 9,
  place: { gasUsed: 799641, cost: '$0.02398923' },
  cancel: { gasUsed: 241730, cost: '$0.0072519' }
}
{
  numOrders: 10,
  place: { gasUsed: 877824, cost: '$0.02633472' },
  cancel: { gasUsed: 262647, cost: '$0.00787941' }
}
*/
