const utils = require('../test/utils')
const {
    txOptions,
    getTxOptions,
    sleep,
} = utils

const config = {
    OrderBook: '0x0300000000000000000000000000000000000000',
    MarginAccount: '0x0300000000000000000000000000000000000001',
    ClearingHouse: '0x0300000000000000000000000000000000000002',
    Bibliophile: '0x0300000000000000000000000000000000000003'
}

async function deployToken(name, symbol, decimals) {
    const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    return ERC20Mintable.deploy(name, symbol, decimals, getTxOptions())
}

async function setupAMM(ammOptions, slowMode=true) {
    if (!ammOptions.oracleAddress) {
        const ma = await ethers.getContractAt('MarginAccount', config.MarginAccount)
        ammOptions.oracleAddress = await ma.oracle()
        console.log(`ammOptions.oracleAddress was not set, using oracleAddress=${ammOptions.oracleAddress} stored in MarginAccount=${config.MarginAccount}`)
    }
    console.log('setupAMM', ammOptions)
    const { governance, name, underlyingAddress, oracleAddress } = ammOptions
    return _setupAmm(
        governance,
        [ name, underlyingAddress, oracleAddress ],
        ammOptions,
        slowMode
    )
}

async function _setupAmm(governance, args, ammOptions, slowMode) {
    const { initialRate, testAmm, whitelist, minSize, oracleAddress } = ammOptions
    const AMM = await ethers.getContractFactory('AMM')
    const TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')

    let admin = await ethers.provider.getStorageAt(config.OrderBook, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103')
    const ammImpl = await AMM.deploy(config.ClearingHouse, getTxOptions())

    let constructorArguments = [
        ammImpl.address,
        '0x' + admin.slice(26),
        ammImpl.interface.encodeFunctionData('initialize', args.concat([ ethers.utils.parseUnits(minSize.toString(), 18), governance ]))
    ]
    const ammProxy = await TransparentUpgradeableProxy.deploy(...constructorArguments, getTxOptions())
    await ammProxy.deployTransaction.wait()

    const amm = await ethers.getContractAt(testAmm ? 'TestAmm' : 'AMM', ammProxy.address)

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
        await orderBook.initializeMinSize(ethers.utils.parseUnits(minSize.toString(), 18), getTxOptions())
    }

    if (slowMode) {
        await sleep(3) // if the above txs aren't mined, read calls to amm might fail
    }

    return { amm }
}

/**
 *
 * @param amount amount to add scaled to 1e6
 * @dev assumes trader has gas token >= amount * 1e12
 */
function addVUSDWithReserve(trader, amount) {
    return vusd.connect(trader).mintWithReserve(trader.address, amount, { value: amount.mul(1e12), gasLimit: 5e6 })
}

/**
 *
 * @param margin husd margin to add scaled to 1e6
 * @dev assumes trader has gas token >= amount * 1e12
 */
async function addMargin(trader, amount, txOpts={}) {
    const ma = await ethers.getContractAt('MarginAccount', config.MarginAccount)
    const marginAccountHelper = await ethers.getContractAt('MarginAccountHelper', await ma.marginAccountHelper())
    return marginAccountHelper.connect(trader).addVUSDMarginWithReserve(amount, Object.assign(txOpts, { value: amount.mul(1e12) }))
}

async function initializeTxOptionsFor0thSigner() {
    signers = await ethers.getSigners()
    governance = signers[0].address

    txOptions.nonce = await signers[0].getTransactionCount()
    // this is a hack for an interesting use-case
    // when we deploy an implementation contract (tx1) and subsequently the TransparentProxy (tx2), the gas estimation for tx2 might fail because the tx1 is not yet mined
    // however, if we pass the gasLimit here, the estimation is skipped and nonce makes sure that tx1 and then tx2 is mined
    txOptions.gasLimit = 5e6
}

async function getImplementationFromProxy(address) {
    let _impl = await ethers.provider.getStorageAt(address, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc')
    return '0x' + _impl.slice(26)
}

async function getAdminFromProxy(address) {
    let admin = await ethers.provider.getStorageAt(address, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103')
    return '0x' + admin.slice(26)
}

module.exports = {
    config,
    deployToken,
    setupAMM,
    addVUSDWithReserve,
    addMargin,
    initializeTxOptionsFor0thSigner,
    getImplementationFromProxy,
    getAdminFromProxy
}
