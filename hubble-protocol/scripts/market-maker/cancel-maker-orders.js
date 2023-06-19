const ethers = require('ethers')

const config = require('../hubblev2next')
const { Exchange } = require('./exchange');

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY_MAKER, provider);
const exchange = new Exchange(provider, config)

const cancelAllOrders = async () => {
    return exchange.cancelAllOrders(signer);
};

const debug = async () => {
    const orders = await exchange.getTraderOpenOrders(signer.address, '')
    console.log(orders.length)
    for (const order of orders) {
        if (order.ReduceOnly) console.log(order)
    }
};

const approveHusd = async () => {
    const husd = new ethers.Contract(
        config.contracts.vusd,
        require('../../artifacts/contracts/VUSD.sol/VUSD.json').abi,
        provider
    )
    await husd.connect(signer).approve(config.contracts.MarginAccount, ethers.constants.MaxUint256)
}

cancelAllOrders()
// debug()
// approveHusd()
