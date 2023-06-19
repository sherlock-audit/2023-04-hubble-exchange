const { expect } = require('chai')
const { forkNetwork, assertBounds, constants: { _1e6 } } = require('../utils')

const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const EthUsdAggregator = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'

/*
Last two hour price samples and their timestamp at block 13322875
roundId | EthPrice | Timestamp
92233720368547769572 279755792457 1632946674
92233720368547769571 281283735224 1632945322
92233720368547769570 282303299782 1632941715
92233720368547769569 282107330840 1632938204
aggregator decimals = 8
*/

describe('Oracle Unit Tests', function() {
    before(async function() {
        await forkNetwork('mainnet', 13322875)
        signers = await ethers.getSigners()
        alice = signers[0].address

        const Oracle = await ethers.getContractFactory('Oracle')
        oracle = await Oracle.deploy()
        await oracle.initialize(alice) // governance
        await oracle.setAggregator(weth, EthUsdAggregator)
    })

    it('get underlying Twap Price', async function () {
        // blocktimestamp = 1632948142
        // twap for last 7200 seconds = ((1632948142-1632946674)*279755792457 + (1632946674-1632945322)*281283735224 + (1632945322-1632941715)*282303299782 + (7200 - (1632948142-1632941715))*282107330840) / 7200 = 281571400333
        // 281571726936 / 100 (6 decimals)
        let price = await oracle.getUnderlyingTwapPrice(weth, 7200)
        assertBounds(price, _1e6.mul(2815), _1e6.mul(2816))

        price = await oracle.getUnderlyingTwapPrice(weth, 3600)
        assertBounds(price, _1e6.mul(2808), _1e6.mul(2809))
    })

    it('asking interval less than latest snapshot, return latest price directly', async () => {
        expect(await oracle.getUnderlyingTwapPrice(weth, 1400)).to.eq('2797557924');
    })

    it('revert when asking intervel is 0', async () => {
        await expect(oracle.getUnderlyingTwapPrice(weth, 0)).to.be.revertedWith('interval can\'t be 0')
    })
})
