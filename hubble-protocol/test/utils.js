const { expect } = require('chai')
const { BigNumber } = require('ethers')
const { ethers, network } = require('hardhat')

const ZERO = BigNumber.from(0)
const _1e6 = BigNumber.from(10).pow(6)
const _1e8 = BigNumber.from(10).pow(8)
const _1e12 = BigNumber.from(10).pow(12)
const _1e18 = ethers.constants.WeiPerEther
const feeSink = new ethers.Wallet.createRandom()

const DEFAULT_TRADE_FEE = 0.0005 * 1e6 /* 0.05% */
const OBGenesisProxyAddress = '0x0300000000000000000000000000000000000000'
const MAGenesisProxyAddress = '0x0300000000000000000000000000000000000001'
const CHGenesisProxyAddress = '0x0300000000000000000000000000000000000002'

let txOptions = {}
const verification = []

/**
 * signers global var should have been intialized before the call to this fn
 * @dev getTxOptions() is a weird quirk that lets us use this script for both local testing and prod deployments
*/
async function setupContracts(options = {}) {
    options = Object.assign(
        {
            tradeFee: DEFAULT_TRADE_FEE,
            makerFee: DEFAULT_TRADE_FEE,
            restrictedVUSD: true,
            governance: signers[0].address,
            setupAMM: true,
            testOracle: true,
            mockOrderBook: true,
            testClearingHouse: true
        },
        options
    )
    ;({ governance } = options)

    // uncomment to check when a particular nonce is being processed in the chain
    // ethers.provider.on('pending', (args) => {
    //     ;({nonce, hash} = args)
    //     console.log('in pending', {nonce, hash});
    // })

    ;([
        Registry,
        ERC20Mintable,
        AMM,
        MinimalForwarder,
        TransparentUpgradeableProxy,
        ProxyAdmin
    ] = await Promise.all([
        ethers.getContractFactory('Registry'),
        ethers.getContractFactory('ERC20Mintable'),
        ethers.getContractFactory(options.amm && options.amm.testAmm ? 'TestAmm' : 'AMM'),
        ethers.getContractFactory('contracts/MinimalForwarder.sol:MinimalForwarder'),
        ethers.getContractFactory('TransparentUpgradeableProxy'),
        ethers.getContractFactory('ProxyAdmin')
    ]))

    ;([ proxyAdmin, forwarder, usdc ] = await Promise.all([
        options.proxyAdmin ? ethers.getContractAt('ProxyAdmin', options.proxyAdmin) : ProxyAdmin.deploy(getTxOptions()),
        MinimalForwarder.deploy(getTxOptions()),
        options.reserveToken ? ethers.getContractAt('IUSDC', options.reserveToken) : ERC20Mintable.deploy('USD Coin', 'USDC', 6, getTxOptions())
    ]))

    vusd = await setupUpgradeableProxy(
        options.restrictedVUSD ? 'RestrictedVusd' : 'VUSD',
        proxyAdmin.address,
        ['Hubble USD', 'hUSD']
    )

    // setup genesis proxies on the hubblenet if requested
    let clearingHouseProxy, orderBookProxy, marginAccountProxy
    if (options.genesisProxies) {
        ;([orderBookProxy, marginAccountProxy, clearingHouseProxy] = await Promise.all([
            ethers.getContractAt('GenesisTUP', OBGenesisProxyAddress),
            ethers.getContractAt('GenesisTUP', MAGenesisProxyAddress),
            ethers.getContractAt('GenesisTUP', CHGenesisProxyAddress)
        ]))
        await Promise.all([
            orderBookProxy.setGenesisAdmin(proxyAdmin.address, getTxOptions()),
            marginAccountProxy.setGenesisAdmin(proxyAdmin.address, getTxOptions()),
            clearingHouseProxy.setGenesisAdmin(proxyAdmin.address, getTxOptions())
        ])
    }

    let initArgs = [ governance, vusd.address ]
    let deployArgs = [ forwarder.address ]
    if (options.genesisProxies) {
        marginAccount = await setupGenesisProxy('MarginAccount', proxyAdmin, initArgs, deployArgs, marginAccountProxy)
    } else {
        marginAccount = await setupUpgradeableProxy(
            `${options.mockMarginAccount ? 'Mock' : ''}MarginAccount`,
            proxyAdmin.address,
            initArgs,
            deployArgs,
            marginAccountProxy
        )
    }

    insuranceFund = await setupUpgradeableProxy('InsuranceFund', proxyAdmin.address, [ governance ])

    initArgs = [ governance, vusd.address, marginAccount.address, insuranceFund.address ]
    marginAccountHelper = await setupUpgradeableProxy('MarginAccountHelper', proxyAdmin.address, initArgs)

    if (options.restrictedVUSD) {
        const transferRole = ethers.utils.id('TRANSFER_ROLE')
        await vusd.grantRoles(
            [ transferRole, transferRole, transferRole ],
            [ marginAccountHelper.address, marginAccount.address, insuranceFund.address ],
            getTxOptions()
        )
    }

    oracle = await setupUpgradeableProxy(options.testOracle ? 'TestOracle' : 'Oracle', proxyAdmin.address, [ governance ])
    tx = await oracle.setStablePrice(vusd.address, 1e6, getTxOptions()) // $1
    await tx.wait()

    const hubbleReferral = await setupUpgradeableProxy('HubbleReferral', proxyAdmin.address)

    if (!clearingHouseProxy) { // a genesis proxy hasnt been setup
        let constructorArguments = [
            oracle.address /* random contract address */,
            proxyAdmin.address,
            '0x'
        ]
        clearingHouseProxy = await TransparentUpgradeableProxy.deploy(...constructorArguments, getTxOptions())
    }
    initArgs = [ 'Hubble', '2.0', governance ]
    deployArgs = [ clearingHouseProxy.address, marginAccount.address ]
    if (options.genesisProxies) {
        orderBook = await setupGenesisProxy('OrderBook', proxyAdmin, initArgs, deployArgs, orderBookProxy)
    } else {
        orderBook = await setupUpgradeableProxy(
            'OrderBook',
            proxyAdmin.address,
            initArgs,
            deployArgs
        )
    }

    initArgs = [
        governance,
        feeSink.address,
        marginAccount.address,
        orderBook.address,
        vusd.address,
        hubbleReferral.address,
    ]

    deployArgs = []
    if (options.genesisProxies) {
        clearingHouse = await setupGenesisProxy('ClearingHouse', proxyAdmin, initArgs, deployArgs, clearingHouseProxy)
    } else {
        clearingHouse = await setupUpgradeableProxy(
            options.testClearingHouse ? 'TestClearingHouse' : 'ClearingHouse',
            proxyAdmin.address,
            initArgs,
            deployArgs,
            clearingHouseProxy
        )
    }

    await vusd.grantRole(ethers.utils.id('MINTER_ROLE'), marginAccount.address, getTxOptions())

    constructorArguments = [oracle.address, clearingHouse.address, insuranceFund.address, marginAccount.address, vusd.address, orderBook.address, marginAccountHelper.address]
    registry = await Registry.deploy(...constructorArguments.concat(getTxOptions()))
    await Promise.all([
        marginAccount.syncDeps(registry.address, 5e4, getTxOptions()), // liquidationIncentive = 5% = .05 scaled 6 decimals
        insuranceFund.syncDeps(registry.address, getTxOptions()),
    ])

    await clearingHouse.setParams(
        0.1 * 1e6, // 10% maintenance margin, 10x
        0.2 * 1e6, // 20% minimum allowable margin, 5x
        options.tradeFee,
        options.makerFee,
        50, // referralShare = .5bps
        100, // feeDiscount = 1bps
        0.05 * 1e6, // liquidationPenalty = 5%
        getTxOptions()
    )

    if (options.mockOrderBook) {
        await clearingHouse.setOrderBook(signers[0].address)
    }

    const HubbleViewer = await ethers.getContractFactory('HubbleViewer')
    hubbleViewer = await HubbleViewer.deploy(clearingHouse.address, marginAccount.address, registry.address, getTxOptions())

    const Leaderboard = await ethers.getContractFactory('Leaderboard')
    leaderboard = await Leaderboard.deploy(hubbleViewer.address, getTxOptions())

    const res = {
        registry,
        marginAccount,
        marginAccountHelper,
        clearingHouse,
        orderBook,
        hubbleViewer,
        hubbleReferral,
        vusd,
        usdc,
        oracle,
        insuranceFund,
        forwarder,
        tradeFee: options.tradeFee,
    }

    if (options.setupAMM) {
        weth = await setupRestrictedTestToken('Hubble Ether', 'hWETH', 18)
        ;({ amm } = await setupAmm(
            governance,
            [ 'ETH-PERP', weth.address, oracle.address ],
            options.amm,
            options.genesisProxies
        ))
        await amm.setPriceSpreadParams(20 * 1e4, 20 * 1e4)
        Object.assign(res, { amm, weth })
    }

    // console.log(await generateConfig(leaderboard.address))
    return res
}

function getTxOptions() {
    const res = {}
    if (txOptions.nonce != null) {
        res.nonce = txOptions.nonce++
    }
    if (txOptions.gasLimit != null) {
        res.gasLimit = txOptions.gasLimit
    }
    if (txOptions.gasPrice != null) {
        res.gasPrice = txOptions.gasPrice
    }
    return res
}

async function setupGenesisProxy(contract, proxyAdmin, initArgs, deployArgs = [], proxy) {
    const factory = await ethers.getContractFactory(contract)
    const impl = await factory.deploy(...deployArgs, getTxOptions())

    const _data = initArgs
        ? impl.interface.encodeFunctionData('initialize', initArgs)
        : '0x'

    const proxyContract = await ethers.getContractAt(contract, proxy.address)
    let _impl = await ethers.provider.getStorageAt(proxy.address, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc')

    // even though initializer has been removed from MarginAccount and ClearingHouse, it needs to be retained in OrderBook.sol due to semantics of __EIP712_init call in the constructor
    // for CH and MA we still need to call upgrade so that newly deployed deps can be updated
    if (_impl != '0x' + '0'.repeat(64)) {
        await proxyAdmin.upgrade(proxy.address, impl.address, getTxOptions())
        // re-intializing CH and MA so that all related contract addresses(like vusd, amms) and state variables are updated on re-deploy
        if (["ClearingHouse", "MarginAccount"].includes(contract)) {
            await proxyContract.initialize(...initArgs, getTxOptions())
        }
    } else {
        await proxyAdmin.upgradeAndCall(proxy.address, impl.address, _data, getTxOptions())
    }
    return proxyContract
}

async function setupUpgradeableProxy(contract, admin, initArgs, deployArgs = [], proxy) {
    const factory = await ethers.getContractFactory(contract)
    const impl = await factory.deploy(...deployArgs, getTxOptions())
    verification.push({ name: contract, address: impl.address, constructorArguments: deployArgs })
    const _data = initArgs
        ? impl.interface.encodeFunctionData('initialize', initArgs)
        : '0x'
    const constructorArguments = [impl.address, admin, _data]
    // if (contract == 'InsuranceFund') { // will keep this for debugging in the future
    //     console.log('pendingObligation', await impl.pendingObligation())
    // }
    if (!proxy) {
        proxy = await TransparentUpgradeableProxy.deploy(...constructorArguments, getTxOptions())
    } else {
        await proxyAdmin.upgradeAndCall(proxy.address, impl.address, _data, getTxOptions())
    }

    verification.push({ name: 'TransparentUpgradeableProxy', impl: contract, address: proxy.address, constructorArguments })
    return ethers.getContractAt(contract, proxy.address)
}

async function setupAmm(governance, args, ammOptions, slowMode) {
    const options = Object.assign(
        {
            initialRate: 1000, // for ETH perp
            whitelist: true,
            minSize: 1e8,
        },
        ammOptions
    )
    const { initialRate, testAmm, whitelist, minSize  } = options

    const ammImpl = await AMM.deploy(clearingHouse.address, getTxOptions())
    let constructorArguments = [
        ammImpl.address,
        proxyAdmin.address,
        ammImpl.interface.encodeFunctionData('initialize', args.concat([ minSize, governance ]))
    ]
    const ammProxy = await TransparentUpgradeableProxy.deploy(...constructorArguments, getTxOptions())
    await ammProxy.deployTransaction.wait()

    verification.push({ name: 'TransparentUpgradeableProxy', impl: 'AMM', address: ammProxy.address, constructorArguments })
    const amm = await ethers.getContractAt(testAmm ? 'TestAmm' : 'AMM', ammProxy.address)

    if (slowMode) {
        await sleep(5) // if the above txs aren't mined, read calls to amm fail
    }

    if (initialRate) {
        // amm.liftOff() needs the price for the underlying to be set
        // set index price within price spread
        const underlyingAsset = await amm.underlyingAsset();
        await oracle.setUnderlyingTwapPrice(underlyingAsset, ethers.utils.parseUnits(initialRate.toString(), 6), getTxOptions())
        await oracle.setUnderlyingPrice(underlyingAsset, ethers.utils.parseUnits(initialRate.toString(), 6), getTxOptions())
    }

    if (whitelist) {
        // console.log('whitelisting', amm.address)
        await clearingHouse.whitelistAmm(amm.address, getTxOptions())
        await orderBook.initializeMinSize(minSize, getTxOptions())
    }

    return { amm }
}

async function setupRestrictedTestToken(name, symbol, decimals) {
    const RestrictedErc20 = await ethers.getContractFactory('RestrictedErc20')
    const tok = await RestrictedErc20.deploy(name, symbol, decimals, getTxOptions())
    // avoiding await tok.TRANSFER_ROLE(), because that reverts if the above tx hasn't confirmed
    await tok.grantRole(ethers.utils.id('TRANSFER_ROLE'), marginAccount.address, getTxOptions())
    return tok
}

/**
* @dev to be used only for hardhat tests, do not use with subnet
 */
async function addMargin(trader, margin, token = usdc, index = 0, marginAccountHelper_ = marginAccountHelper) {
    if (index == 0) {
        const hgtAmount = _1e12.mul(margin)
        const balance = await ethers.provider.getBalance(trader.address)
        if (balance.lt(hgtAmount)) {
            // adding extra gas token to pay for gas
            // leading 0s throw error in next step, hence truncating leading 0s
            await setBalance(trader.address, hgtAmount.mul(2).toHexString().replace(/0x0+/, "0x"))
        }
        await marginAccountHelper_.connect(trader).addVUSDMarginWithReserve(margin, {value: hgtAmount})
    } else {
        await token.connect(trader).approve(marginAccount.address, margin)
        await marginAccount.connect(trader).addMargin(index, margin)
    }
}

async function filterEvent(tx, name) {
    const { events } = await tx.wait()
    return events.find(e => e.event == name)
}

async function getTradeDetails(tx, tradeFee = DEFAULT_TRADE_FEE, type = 'PositionModified') {
    const positionModifiedEvent = await filterEvent(tx, type)
    return {
        quoteAsset: positionModifiedEvent.args.baseAsset.abs().mul(positionModifiedEvent.args.price).div(_1e18),
        fee: positionModifiedEvent.args.fee
    }
}

async function parseRawEvent(tx, emitter, name) {
    const { events } = await tx.wait()
    return parseRawEvent2(events, emitter, name)
}

function parseRawEvent2(events, emitter, name) {
    const event = events.find(e => {
        if (e.address == emitter.address) {
            return emitter.interface.parseLog(e).name == name
        }
        return false
    })
    return emitter.interface.parseLog(event)
}

async function assertions(contracts, trader, vals, shouldLog) {
    const { amm, clearingHouse, marginAccount } = contracts
    const [ position, { notionalPosition, unrealizedPnl }, marginFraction, margin ] = await Promise.all([
        amm.positions(trader),
        amm.getNotionalPositionAndUnrealizedPnl(trader),
        clearingHouse.calcMarginFraction(trader, true, 1),
        marginAccount.getNormalizedMargin(trader)
    ])
    const { size, openNotional } = position

    if (shouldLog) {
        console.log(position, notionalPosition, unrealizedPnl, marginFraction, size, openNotional)
    }

    if (vals.size != null) {
        expect(size).to.eq(vals.size)
    }
    if (vals.openNotional != null) {
        expect(openNotional).to.eq(vals.openNotional)
    }
    if (vals.notionalPosition != null) {
        expect(notionalPosition).to.eq(vals.notionalPosition)
    }
    if (vals.unrealizedPnl != null) {
        expect(unrealizedPnl).to.eq(vals.unrealizedPnl)
    }
    if (vals.margin != null) {
        expect(margin).to.eq(vals.margin)
    }
    if (vals.marginFractionNumerator != null) {
        expect(marginFraction).to.eq(vals.marginFractionNumerator.mul(_1e6).div(notionalPosition))
    }
    if (vals.marginFraction != null) {
        expect(marginFraction).to.eq(vals.marginFraction)
    }

    return { position, notionalPosition, unrealizedPnl, marginFraction }
}

async function impersonateAccount(address) {
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [address],
    });

    return ethers.provider.getSigner(address)
}

async function stopImpersonateAccount(address) {
    await hre.network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [address],
    });
}

async function gotoNextFundingTime(amm) {
    return network.provider.send('evm_setNextBlockTimestamp', [(await amm.nextFundingTime()).toNumber()]);
}

function forkNetwork(_network, blockNumber) {
    return network.provider.request({
        method: "hardhat_reset",
        params: [{
            forking: {
                jsonRpcUrl: `https://eth-${_network}.alchemyapi.io/v2/${process.env.ALCHEMY}`,
                blockNumber
            }
        }]
    })
}

function forkCChain(blockNumber) {
    return network.provider.request({
        method: "hardhat_reset",
        params: [{
            forking: {
                jsonRpcUrl: `https://api.avax.network/ext/bc/C/rpc`,
                blockNumber
            }
        }]
    })
}

function forkFuji(blockNumber) {
    return network.provider.request({
        method: "hardhat_reset",
        params: [{
            forking: {
                jsonRpcUrl: `https://api.avax-test.network/ext/bc/C/rpc`,
                blockNumber
            }
        }]
    })
}

async function signTransaction(signer, to, data, forwarder, value = 0, gas = 1000000) {
    const types = {
        ForwardRequest: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'gas', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'data', type: 'bytes' },
        ],
    }

    const domain = {
        name: 'MinimalForwarder',
        version: '0.0.1',
        chainId: await web3.eth.getChainId(),
        verifyingContract: forwarder.address,
    }

    const req = {
        from: signer.address,
        to: to.address,
        value,
        gas,
        nonce: (await forwarder.getNonce(signer.address)).toString(),
        data
    };
    const sign = await signer._signTypedData(domain, types, req)
    return { sign, req }
}

async function assertBounds(v, lowerBound, upperBound) {
    if (lowerBound) expect(v).gte(lowerBound)
    if (upperBound) expect(v).lte(upperBound)
}

// doesn't print inactive AMMs
async function generateConfig(hubbleViewerAddress) {
    const hubbleViewer = await ethers.getContractAt('HubbleViewer', hubbleViewerAddress)
    const clearingHouse = await ethers.getContractAt('ClearingHouse', await hubbleViewer.clearingHouse())
    const marginAccount = await ethers.getContractAt('MarginAccount', await hubbleViewer.marginAccount())
    const marginAccountHelperAddress = await marginAccount.marginAccountHelper()

    const orderBook = await ethers.getContractAt('OrderBook', await clearingHouse.orderBook())
    const vusd = await ethers.getContractAt('VUSD', await clearingHouse.vusd())
    const hubbleReferral = await clearingHouse.hubbleReferral()

    const _amms = await clearingHouse.getAMMs()
    const amms = []
    for (let i = 0; i < _amms.length; i++) {
        const a = await ethers.getContractAt('AMM', _amms[i])
        amms.push({
            perp: await a.name(),
            address: a.address,
            underlying: await a.underlyingAsset(),
        })
    }
    let _collateral = await marginAccount.supportedAssets()
    const collateral = []
    for (let i = 0; i < _collateral.length; i++) {
        const asset = await ethers.getContractAt('ERC20PresetMinterPauser', _collateral[i].token)
        collateral.push({
            name: await asset.name(),
            ticker: await asset.symbol(),
            decimals: _collateral[i].decimals.toString(),
            weight: _collateral[i].weight.toString(),
            address: asset.address
        })
    }

    let proxyAdmin = await ethers.provider.getStorageAt(clearingHouse.address, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103') // admin slot
    const res = {
        contracts: {
            OrderBook: orderBook.address,
            ClearingHouse: clearingHouse.address,
            HubbleViewer: hubbleViewer.address,
            MarginAccount: marginAccount.address,
            Oracle: await marginAccount.oracle(),
            InsuranceFund: await marginAccount.insuranceFund(),
            Registry: await hubbleViewer.registry(),
            MarginAccountHelper: marginAccountHelperAddress,
            HubbleReferral: hubbleReferral,
            vusd: vusd.address,
            amms,
            collateral,
            proxyAdmin: '0x' + proxyAdmin.slice(26, 66)
        },
        systemParams: {
            maintenanceMargin: (await clearingHouse.maintenanceMargin()).toString(),
            numCollateral: collateral.length,
            takerFee: (await clearingHouse.takerFee()).toString(),
            makerFee: (await clearingHouse.makerFee()).toString(),
            liquidationFee: (await clearingHouse.liquidationPenalty()).toString(),
        }
    }
    return res
}

function setDefaultClearingHouseParams(clearingHouse) {
    return clearingHouse.setParams(
        1e5, // maintenance margin
        1e5, // minimum allowable margin
        5e2, // takerFee
        5e2, // makerFee
        50, // referralShare = .5bps
        100, // feeDiscount = 1bps
        5e4, // liquidationPenalty
    )
}

function sleep(s) {
    console.log(`Requested a sleep of ${s} seconds...`)
    return new Promise(resolve => setTimeout(resolve, s * 1000));
}

function bnToFloat(num, decimals = 6) {
    return parseFloat(ethers.utils.formatUnits(num.toString(), decimals))
}

async function unbondAndRemoveLiquidity(signer, amm, index, dToken, minQuote, minBase) {
    await amm.connect(signer).unbondLiquidity(dToken)
    await gotoNextUnbondEpoch(amm, signer.address)
    return clearingHouse.connect(signer).removeLiquidity(index, dToken, minQuote, minBase)
}

async function gotoNextWithdrawEpoch(amm, maker) {
    return network.provider.send(
        'evm_setNextBlockTimestamp',
        [(await amm.makers(maker)).unbondTime.toNumber() + 86401]
    );
}

async function gotoNextUnbondEpoch(amm, maker) {
    return network.provider.send(
        'evm_setNextBlockTimestamp',
        [(await amm.makers(maker)).unbondTime.toNumber()]
    );
}

async function setBalance(address, balance) {
    await network.provider.send("hardhat_setBalance", [
        address,
        balance,
    ]);
}

async function calcGasPaid(tx) {
    const wait = await tx.wait()
    return wait.cumulativeGasUsed.mul(wait.effectiveGasPrice)
}

async function gotoNextIFUnbondEpoch(insuranceFund, usr) {
    return network.provider.send(
        'evm_setNextBlockTimestamp',
        [(await insuranceFund.unbond(usr)).unbondTime.toNumber()]
    );
}

module.exports = {
    constants: { _1e6, _1e8, _1e12, _1e18, ZERO, feeSink: feeSink.address },
    BigNumber,
    txOptions,
    verification,
    getTxOptions,
    setupContracts,
    setupUpgradeableProxy,
    filterEvent,
    getTradeDetails,
    assertions,
    impersonateAccount,
    stopImpersonateAccount,
    gotoNextFundingTime,
    forkNetwork,
    setupAmm,
    setupRestrictedTestToken,
    signTransaction,
    addMargin,
    parseRawEvent,
    parseRawEvent2,
    assertBounds,
    generateConfig,
    sleep,
    bnToFloat,
    unbondAndRemoveLiquidity,
    gotoNextWithdrawEpoch,
    forkCChain,
    forkFuji,
    gotoNextUnbondEpoch,
    setBalance,
    setDefaultClearingHouseParams,
    calcGasPaid,
    gotoNextIFUnbondEpoch
}
