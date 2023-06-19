const utils = require('../../test/utils')

const {
    constants: { _1e6, _1e18 },
    sleep,
    getTxOptions,
} = utils

const hubblev2next = require('../hubblev2next')
const { marketInfo } = hubblev2next

const { addMargin, initializeTxOptionsFor0thSigner, setupAMM, deployToken, getImplementationFromProxy, getAdminFromProxy } = require('../common')
const config = require('../hubblev2next').contracts
const { maker, taker, faucet } = hubblev2next.marketMaker

async function mintNative() {
    const nativeMinter = await ethers.getContractAt('INativeMinter', '0x0200000000000000000000000000000000000001')
    // await nativeMinter.setEnabled(taker)
    // await nativeMinter.setEnabled(faucet) // done during deploy
    await nativeMinter.mintNativeCoin(maker, _1e18.mul(688000))
    // await nativeMinter.mintNativeCoin(taker, _1e18.mul(105000))
}

async function depositMargin() {
    ;([, alice, bob] = await ethers.getSigners())
    const amount = _1e6.mul(1e5)
    await addMargin(alice, amount)
    await addMargin(bob, amount)

    await sleep(3)
    const marginAccount = await ethers.getContractAt('MarginAccount', config.MarginAccount)
    console.log({
        alice: await marginAccount.getAvailableMargin(alice.address),
        bob: await marginAccount.getAvailableMargin(bob.address),
    })
}

async function updateTestOracle() {
    // let _admin = await ethers.provider.getStorageAt(<address>, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103')
    // console.log(_admin)

    const oracle = await ethers.getContractAt('TestOracle', config.Oracle)
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    console.log({
        admin_at_slot: await getAdminFromProxy(oracle.address),
        admin_from_pa: await proxyAdmin.getProxyAdmin(oracle.address),
        impl_at_slot: await getImplementationFromProxy(oracle.address)
    })

    const TestOracle = await ethers.getContractFactory('TestOracle')
    const newImpl = await TestOracle.deploy()
    console.log({ newImpl: newImpl.address })

    await proxyAdmin.upgrade(oracle.address, newImpl.address)
    await sleep(3)
    console.log('newImpl', await getImplementationFromProxy(oracle.address))
}

async function whitelistValidators() {
    await initializeTxOptionsFor0thSigner()
    const orderBook = await ethers.getContractAt('OrderBook', config.OrderBook)
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0xaD6d1e84980a634b516f9558403a30445D614246'), true, getTxOptions())
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x74E5490c066AeF921E205e5cb9Ac4A4eb693c2Cf'), true, getTxOptions())
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x4fA904477fd5cE9D26f29b9F61210aFC8DCA790a'), true, getTxOptions())
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x630Ee73BE56f5B712899a0d6893e76a802Ef5749'), true, getTxOptions())
}

async function setParams() {
    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    console.log(await Promise.all([
        ch.maintenanceMargin(),
        ch.minAllowableMargin(),
        ch.takerFee(),
        ch.makerFee(),
        ch.referralShare(),
        ch.tradingFeeDiscount(),
        ch.liquidationPenalty(),
    ]))
    await ch.setParams(
        '100000', // 0.1
        '200000', // 0.2
        '500', // .05%
        '-50', // -0.005%
        '50',
        '100',
        '50000'
    )
}

async function setupNewAmms() {
    await initializeTxOptionsFor0thSigner()

    const toSetup = marketInfo.slice(3)
    const amms = []
    for (let i = 0; i < toSetup.length; i++) {
        const name = toSetup[i].name.slice(0, toSetup[i].name.length - 5)
        // console.log(`setting up ${name}`)
        const underlying = await deployToken(`hubblenet-${name}-tok`, `hubblenet-${name}-tok`, 18)
        const ammOptions = {
            governance,
            name: `${name}-Perp`,
            underlyingAddress: underlying.address,
            initialRate: toSetup[i].initialRate,
            oracleAddress: hubblev2next.contracts.Oracle,
            minSize: toSetup[i].minOrderSize,
            testAmm: false,
            whitelist: true
        }
        const { amm } = await setupAMM(ammOptions, false)
        amms.push({
            perp: `${name}-Perp`,
            address: amm.address,
            underlying: underlying.address,
        })
        console.log(amms)
    }
}

async function setupInitialRate() {
    await initializeTxOptionsFor0thSigner()

    const toSetup = marketInfo
    const oracle = await ethers.getContractAt('TestOracle', config.Oracle)
    for (let i = 3; i < toSetup.length; i++) {
        let { name, initialRate } = toSetup[i]
        name = toSetup[i].name.slice(0, toSetup[i].name.length - 5)
        const underlyingAsset = hubblev2next.contracts.amms[i].underlying
        console.log(`setting up ${name}, ${initialRate}, ${underlyingAsset}`)
        await oracle.setUnderlyingTwapPrice(underlyingAsset, ethers.utils.parseUnits(initialRate.toString(), 6), getTxOptions())
        await oracle.setUnderlyingPrice(underlyingAsset, ethers.utils.parseUnits(initialRate.toString(), 6), getTxOptions())
    }
}

async function setOracleUpdater() {
    await initializeTxOptionsFor0thSigner()
    const oracle = await ethers.getContractAt('TestOracle', config.Oracle)
    await oracle.setUpdater('0xd6AF9F5b2ac25703b0c3B27e634991f554698E66', true, getTxOptions())
    await oracle.setUpdater('0x61583effe246022Bf1dca6cd2877A21C47b56474', true, getTxOptions())
}

async function getAmmsLength() {
    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    console.log(await ch.getAmmsLength())
}

async function whitelistAmm() {
    await initializeTxOptionsFor0thSigner()
    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    // const ob = await ethers.getContractAt('OrderBook', config.OrderBook)
    for (let i = 3; i < 10; i++) {
        const amm = await ethers.getContractAt('AMM', config.amms[i].address)
        // console.log({
        //     name: await amm.name(),
        //     oracle: await amm.oracle(),
        //     governance: await amm.governance(),
        //     nextFundingTime: await amm.nextFundingTime(),
        //     minSizeRequirement: utils.bnToFloat(await amm.minSizeRequirement(), 18)
        // })
        // console.log(await ob.minSizes(i))
        try {
            const tx = await ch.whitelistAmm(config.amms[i].address, getTxOptions())
            console.log(await tx.wait())
            // console.log('estiamte gas', await ch.estimateGas.whitelistAmm(config.amms[i].address))
        } catch(e) {
            console.log(e)
        }
    }
}

// 2.0.0-next.rc.1 update
async function rc1Update() {
    const AMM = await ethers.getContractFactory('AMM')
    const newAMM = await AMM.deploy(config.ClearingHouse)
    console.log({ newAMM: newAMM.address })

    const ClearingHouse = await ethers.getContractFactory('ClearingHouse')
    const newClearingHouse = await ClearingHouse.deploy()
    console.log({ newClearingHouse: newClearingHouse.address })

    const OrderBook = await ethers.getContractFactory('OrderBook')
    const newOrderBook = await OrderBook.deploy(config.ClearingHouse, config.MarginAccount)
    console.log({ newOrderBook: newOrderBook.address })

    // Phase 2
    await sleep(5)
    await initializeTxOptionsFor0thSigner()
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    const tasks = []
    for (let i = 0; i < config.amms.length; i++) {
        tasks.push(proxyAdmin.upgrade(config.amms[i].address, newAMM.address, getTxOptions()))
    }
    tasks.push(proxyAdmin.upgrade(config.ClearingHouse, newClearingHouse.address, getTxOptions()))
    tasks.push(proxyAdmin.upgrade(config.OrderBook, newOrderBook.address, getTxOptions()))

    const txs = await Promise.all(tasks)
    for (let i = 0; i < txs.length; i++) {
        const r = await txs[i].wait()
        console.log(i, r.status)
    }
}

rc1Update()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
