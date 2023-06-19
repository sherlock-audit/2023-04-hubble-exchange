const hubblev2next = {
    "contracts": {
        "OrderBook": "0x0300000000000000000000000000000000000000",
        "ClearingHouse": "0x0300000000000000000000000000000000000002",
        "Bibliophile": "0x0300000000000000000000000000000000000003",
        "HubbleViewer": "0xa1e7b5ffD6FC7261f770d8A190104ED23255aFf2",
        "MarginAccount": "0x0300000000000000000000000000000000000001",
        "Oracle": "0x12dCf1Fbc94A419Ade92019f7459D19f3a1Eb6F0",
        "InsuranceFund": "0x3cAf686de269f17bcC6D17A876ABb1bf2F4BAF51",
        "Registry": "0xa866eD212114921744f02B12853e2E1256D15d65",
        "MarginAccountHelper": "0xd00aB99371857bF80b3e9C7366D8c1CEcE6B7531",
        "HubbleReferral": "0x231255A3dB7800Dc9c2Ed1Dc9e2ED6e8d5516091",
        "vusd": "0xDDFC033DAd5F2Cc52e126B537f39eD6b70372ec6",
        "amms": [
            {
                perp: "ETH-Perp",
                address: "0xa72b463C21dA61cCc86069cFab82e9e8491152a0",
                underlying: "0x98fC50545D4bFFE288e719b11eA05136E6eB1c35"
            },
            {
                perp: 'AVAX-Perp',
                address: '0xd80e57dB448b0692C396B890eE9c791D7386dAdC',
                underlying: '0xb251EC7F0eA692D1188ca4Bc9bEd321E501Eb790'
            },
            {
                perp: 'BTC-Perp',
                address: '0x3408aa4B6C34eA2a41bCD17c22e29ED74026F53a',
                underlying: '0x11B7c6D70774237dCaBF59EFAFdCF5B5C3F484CD'
            },
            {
                perp: 'ARB-Perp',
                address: '0xd9e984C1C094563Fcc0aE95A832C1fEC852d11a3',
                underlying: '0x7c9F7ae6660DB751030AE61e209B0819C7EE1816'
            },
            {
                perp: 'Matic-Perp',
                address: '0x4612455e5C5F41ae992026817897d05390e7848B',
                underlying: '0xF5b1953b7FA3f234dF7995c5c10873BfD25E5658'
            },
            {
                perp: 'OP-Perp',
                address: '0x4695Ff88d1C62F28A05ca65f8A01041F001e6A47',
                underlying: '0xf9a023098FCeb9701999730e47B905561A2ae175'
            },
            {
                perp: 'SOL-Perp',
                address: '0xCC44F3E138027362804A38495012Cf280db514d4',
                underlying: '0xd8f510e40352c89Dd411C7Ada560354508D30230'
            },
            {
                perp: 'DOGE-Perp',
                address: '0x73928AC383AAF0d22388015Df0efeFD90D2CaA2D',
                underlying: '0x5Bf41d86252970eA10Bf3AC8193C158c3BD1b349'
            },
            {
                perp: 'BNB-Perp',
                address: '0x198e4C224Dd31a9551A39A2a7f5fa0F5fE6163D6',
                underlying: '0xE58141fc04eBC3da9cB3B82Eeb888b39f62C1c11'
            },
            {
                perp: 'JOE-Perp',
                address: '0xCAC69755BE3Ab35CF292eC5F048e608CCb46e3FD',
                underlying: '0x5564FB5694BAE59c6305105cfA3bbd0Efd2788C5'
            }
        ],
        "collateral": [
            {
                "name": "Hubble USD",
                "ticker": "hUSD",
                "decimals": "6",
                "weight": "1000000",
                "address": "0xDDFC033DAd5F2Cc52e126B537f39eD6b70372ec6"
            }
        ],
        "proxyAdmin": "0x66bd72f94C5AEA2AFDF7FAd5B23b5E6D55ff9969",
        "governance": "0xeAA6AE79bD3d042644D91edD786E4ed3d783Ca2d"
    },
    "systemParams": {
        "maintenanceMargin": "100000",
        "numCollateral": 1,
        "takerFee": "500",
        "makerFee": "-50",
        "liquidationFee": "50000"
    },
    marketMaker: {
        maker: "0x93dAc05dE54C9d5ee5C59F77518F931168FDEC9b",
        taker: "0xCe743BFA1feaed060adBadfc8974be544b251Fe8",
        faucet: "0x40ac7FaFeBc2D746E6679b8Da77F1bD9a5F1484f",
    },
    // used by market maker
    marketInfo: [
        {
            active: true,
            name: 'ETH-Perp',
            initialRate: 1850,
            x: 0.01, // operate +- 1% of index price
            spread: 2, // $2
            toFixed: 2,
            minOrderSize: 0.01,
            maker: {
                maxOrderSize: 2.7,
                baseLiquidityInMarket: 27 // each side
            },
            taker: {
                maxOrderSize: 5.4,
                baseLiquidityInMarket: 20 // each side
            },
            feed: {
                address: '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',
                chain: 'ethereum'
            }

        },
        {
            active: true,
            name: 'AVAX-Perp',
            initialRate: 15,
            x: 0.01, // operate +- 1% of index price
            spread: 0.1, // $
            toFixed: 1,
            minOrderSize: 0.1,
            maker: {
                maxOrderSize: 300,
                baseLiquidityInMarket: 3000 // each side
            },
            taker: {
                maxOrderSize: 600,
                baseLiquidityInMarket: 2400 // each side
            },
            feed: {
                address: '0xff3eeb22b5e3de6e705b44749c2559d704923fd7',
                chain: 'ethereum'
            }
        },
        {
            active: true,
            name: 'BTC-Perp',
            initialRate: 27000,
            x: 0.02,
            spread: 10, // $
            toFixed: 3,
            minOrderSize: 0.001,
            maker: {
                maxOrderSize: 0.2,
                baseLiquidityInMarket: 2 // each side
            },
            taker: {
                maxOrderSize: 0.4,
                baseLiquidityInMarket: 1.6 // each side
            },
            feed: {
                address: '0xf4030086522a5beea4988f8ca5b36dbc97bee88c',
                chain: 'ethereum'
            }
        },{
            active: true,
            name: 'ARB-Perp',
            initialRate: 1.2,
            x: 0.02, // operate +- 1% of index price
            spread: 0.006, // $
            toFixed: 1,
            minOrderSize: 0.1,
            maker: {
                maxOrderSize: 4e3,
                baseLiquidityInMarket: 4e4 // each side
            },
            taker: {
                maxOrderSize: 8e3,
                baseLiquidityInMarket: 2e4 // each side
            },
            feed: {
                address: '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',
                chain: 'arbitrum'
            }
        },{
            active: true,
            name: 'Matic-Perp',
            initialRate: 0.9,
            x: 0.02, // operate +- 1% of index price
            spread: 0.006, // $
            toFixed: 1,
            minOrderSize: 0.1,
            maker: {
                maxOrderSize: 5e3,
                baseLiquidityInMarket: 5e4 // each side
            },
            taker: {
                maxOrderSize: 1e4,
                baseLiquidityInMarket: 25e3 // each side
            },
            feed: {
                address: '0x7bac85a8a13a4bcd8abb3eb7d6b4d632c5a57676',
                chain: 'ethereum'
            }
        },{
            active: true,
            name: 'OP-Perp',
            initialRate: 1.5,
            x: 0.02, // operate +- 1% of index price
            spread: 0.006, // $
            toFixed: 1,
            minOrderSize: 0.1,
            maker: {
                maxOrderSize: 3500,
                baseLiquidityInMarket: 35000 // each side
            },
            taker: {
                maxOrderSize: 7000,
                baseLiquidityInMarket: 17000 // each side
            },
            feed: {
                address: '0x205aaD468a11fd5D34fA7211bC6Bad5b3deB9b98',
                chain: 'arbitrum'
            }
        },{
            active: true,
            name: 'SOL-Perp',
            initialRate: 21,
            x: 0.01, // operate +- 1% of index price
            spread: 0.1, // $
            toFixed: 1,
            minOrderSize: 0.1,
            maker: {
                maxOrderSize: 250,
                baseLiquidityInMarket: 2500 // each side
            },
            taker: {
                maxOrderSize: 500,
                baseLiquidityInMarket: 1250 // each side
            },
            feed: {
                address: '0x4ffc43a60e009b551865a93d232e33fce9f01507',
                chain: 'ethereum'
            }
        },{
            active: true,
            name: 'DOGE-Perp',
            initialRate: 0.07,
            x: 0.05, // operate +- 1% of index price
            spread: 0.0002, // $2
            toFixed: 0,
            minOrderSize: 1,
            maker: {
                maxOrderSize: 7e4,
                baseLiquidityInMarket: 7e5 // each side
            },
            taker: {
                maxOrderSize: 14e4,
                baseLiquidityInMarket: 35e4 // each side
            },
            feed: {
                address: '0x2465cefd3b488be410b941b1d4b2767088e2a028',
                chain: 'ethereum'
            }
        },{
            active: true,
            name: 'BNB-Perp',
            initialRate: 306,
            x: 0.02, // operate +- 1% of index price
            spread: 1,
            toFixed: 2,
            minOrderSize: 0.01,
            maker: {
                maxOrderSize: 16,
                baseLiquidityInMarket: 165 // each side
            },
            taker: {
                maxOrderSize: 32,
                baseLiquidityInMarket: 80 // each side
            },
            feed: {
                address: '0x14e613AC84a31f709eadbdF89C6CC390fDc9540A',
                chain: 'ethereum'
            }
        },{
            active: true,
            name: 'JOE-Perp',
            initialRate: 0.42,
            x: 0.05, // operate +- 1% of index price
            spread: 0.001, // $2
            toFixed: 1,
            minOrderSize: 0.1,
            maker: {
                maxOrderSize: 6e4,
                baseLiquidityInMarket: 125e3 // each side
            },
            taker: {
                maxOrderSize: 12e4,
                baseLiquidityInMarket: 6e4 // each side
            },
            feed: {
                address: '0x04180965a782e487d0632013aba488a472243542',
                chain: 'arbitrum'
            }
        }
    ]
}

module.exports = hubblev2next
