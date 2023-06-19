const utils = require('../../test/utils')
const { addMargin } = require('./deployUtils')

const {
    constants: { _1e6 },
    setupContracts,
    generateConfig,
    getTxOptions,
    sleep,
    txOptions
} = utils
const gasLimit = 5e6 // subnet genesis file only allows for this much

/**
 * After deployment
 * governance - signers[0]
 * signers[1], signers[2] have 1000 vUSD each
 */

async function main() {
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

    const { marginAccountHelper, orderBook } =  await setupContracts({
        governance,
        restrictedVUSD: false,
        genesisProxies: true,
        mockOrderBook: false,
        testClearingHouse: false,
        amm: {
            initialRate: 2000,
            minSize: utils.BigNumber.from(10).pow(16),
        }
    })

    await addMargin(alice, _1e6.mul(40000), gasLimit)
    await addMargin(bob, _1e6.mul(40000), gasLimit)

    // whitelist evm address for order execution transactions
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x4Cf2eD3665F6bFA95cE6A11CFDb7A2EF5FC1C7E4'), true)

    await sleep(5)
    console.log({ marginAccountHelper: marginAccountHelper.address, leaderboard: leaderboard.address })
    console.log(JSON.stringify(await generateConfig(leaderboard.address, marginAccountHelper.address), null, 0))
}

async function setupAMM() {
    signers = await ethers.getSigners()
    txOptions.nonce = await signers[0].getTransactionCount()
    txOptions.gasLimit = gasLimit

    const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    const avax = await ERC20Mintable.deploy('avax', 'avax', 18, getTxOptions())
    governance = signers[0].address
    ;({ amm: avaxAmm } = await _setupAmm(
        governance,
        [ 'AVAX-PERP', avax.address, config.Oracle ],
        {
            initialRate: 15,
            testAmm: false,
            whitelist: true,
            minSize: utils.BigNumber.from(10).pow(17) // 0.1 AVAX
        }
    ))
    console.log('AVAX AMM', avaxAmm.address) // 0xCD8a1C3ba11CF5ECfa6267617243239504a98d90
}

async function _setupAmm(governance, args, ammOptions, slowMode) {
    const { initialRate, testAmm, whitelist, minSize  } = ammOptions
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
        await sleep(5) // if the above txs aren't mined, read calls to amm fail
    }

    if (initialRate) {
        // amm.liftOff() needs the price for the underlying to be set
        // set index price within price spread
        const oracle = await ethers.getContractAt('TestOracle', config.Oracle)
        const underlyingAsset = await amm.underlyingAsset();
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

async function addMarginAgain() {
    signers = await ethers.getSigners()
    governance = signers[0].address
    ;([, alice, bob] = signers)
    const margin = _1e6.mul(5e4)
    const marginAccountHelper = await ethers.getContractAt('MarginAccountHelper', config.MarginAccountHelper)
    await marginAccountHelper.connect(alice).addVUSDMarginWithReserve(margin, { value: margin.mul(1e12) })
    await marginAccountHelper.connect(bob).addVUSDMarginWithReserve(margin, { value: margin.mul(1e12) })
}

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
