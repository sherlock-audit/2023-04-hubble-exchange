const utils = require('../../test/utils')
const {
    setupContracts,
    generateConfig,
    sleep,
    getTxOptions
} = utils
const { config, deployToken, setupAMM, addMargin, initializeTxOptionsFor0thSigner } = require('../common')

const gasLimit = 5e6

/**
 * After deployment
 * governance - signers[0]
 * validators whitelisted
 * faucet enabled as native minter
 */

async function main() {
    await initializeTxOptionsFor0thSigner()
    const { orderBook, marginAccount, clearingHouse, hubbleViewer, oracle } =  await setupContracts({
        governance,
        restrictedVUSD: false,
        genesisProxies: true,
        mockOrderBook: false,
        testClearingHouse: false,
        tradeFee: 500, // .05%
        makerFee: -50, // -.005%
        setupAMM: false
    })

    const tasks = []
    tasks.push(orderBook.setBibliophile(config.Bibliophile, getTxOptions()))
    tasks.push(marginAccount.setBibliophile(config.Bibliophile, getTxOptions()))
    tasks.push(clearingHouse.setBibliophile(config.Bibliophile, getTxOptions()))

    // whitelist evm address for order execution transactions
    const validators = [
        '0x393bd9ac9dbBe75e84db739Bb15d22cA86D26696'
    ]
    validators.forEach(validator => {
        tasks.push(orderBook.setValidatorStatus(ethers.utils.getAddress(validator), true, getTxOptions()))
    })

    const nativeMinter = await ethers.getContractAt('INativeMinter', '0x0200000000000000000000000000000000000001')
    tasks.push(nativeMinter.setEnabled('0x40ac7FaFeBc2D746E6679b8Da77F1bD9a5F1484f', getTxOptions())) // nickname's faucet
    await Promise.all(tasks)

    const underlying = await deployToken('hubblenet-eth-tok', 'hubblenet-eth-tok', 18)
    const ammOptions = {
        governance,
        name: `ETH-Perp`,
        underlyingAddress: underlying.address,
        initialRate: 1850,
        oracleAddress: oracle.address,
        minSize: 0.01, // ETH
        testAmm: false,
        whitelist: true
    }
    await setupAMM(ammOptions, true /* slowMode */)
    console.log(JSON.stringify(await generateConfig(hubbleViewer.address), null, 0))
}

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
