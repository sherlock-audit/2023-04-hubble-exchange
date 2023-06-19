const N_COINS = 2
const A_MULTIPLIER = 10000
const MIN_A = (N_COINS**N_COINS) * A_MULTIPLIER / 10
const MAX_A = (N_COINS**N_COINS) * A_MULTIPLIER * 100000
const MIN_GAMMA = 10**-8
const MAX_GAMMA = 2 * (10 ** -2)
const MIN_D = 0.1;
const MAX_D = (10 ** 15)

import { ethers } from "ethers";

export class VammJS {
    A = 400000
    gamma = 0.000145
    midFee = 0.0005

    last_prices_timestamp

    balances: Array<number>;
    price_scale: number
    price_oracle: number
    last_prices: number
    ma_half_time
    totalSupply
    xcp_profit
    virtual_price
    adjustment_step
    allowed_extra_profit
    not_adjusted
    D

    constructor(
        balances: Array<number>,
        price_scale: number,
        price_oracle: number,
        last_prices: number,
        ma_half_time,
        totalSupply,
        xcp_profit,
        virtual_price,
        adjustment_step,
        allowed_extra_profit,
        not_adjusted,
        D,
    ) {
        this.balances = balances
        this.D = D
        this.price_scale = price_scale
        this.price_oracle = price_oracle
        this.last_prices = last_prices
        this.ma_half_time = ma_half_time
        this.totalSupply = totalSupply
        this.xcp_profit = xcp_profit
        this.virtual_price = virtual_price
        this.adjustment_step = adjustment_step
        this.allowed_extra_profit = allowed_extra_profit
        this.not_adjusted = not_adjusted
        this.last_prices_timestamp = Math.floor(new Date().getTime()/1000)
    }

    // short
    get_dy(dx: number, balances = this.balances, D = this.D) {
        return get_dy(1, 0, dx, balances, D, this.price_scale, this.A, this.gamma, this.midFee)
    }

    // long
    get_dx(dy: number, balances = this.balances, D = this.D) {
        return get_dx(0, 1, dy, balances, D, this.price_scale, this.A, this.gamma, this.midFee)
    }

    markPrice() {
        return calcMarkPrice(this.balances[0], this.balances[1] * this.price_scale, this.A, this.gamma, this.D, this.price_scale).markPrice
    }

    short(dx: number, min_dy: number) {
        const i = 1
        const j = 0
        const dy = this.get_dy(dx)[0]
        // console.log({ dy, min_dy })
        if (dy < min_dy) throw 'Slippage'
        this.balances[i] += dx
        this.balances[j] -= dy
        const p = !i ? dx/dy : dy/dx
        this._tweak_price([this.A, this.gamma], [this.balances[0], this.balances[1] * this.price_scale], p, 0, this.last_prices_timestamp + 3)
        return dy
    }

    long(dy: number, max_dx: number) {
        const i = 0
        const j = 1
        const dx = this.get_dx(dy)[0]
        // console.log({ dx, max_dx })
        if (dx > max_dx) throw 'Slippage'
        this.balances[i] += dx
        this.balances[j] -= dy
        const p = !i ? dx/dy : dy/dx
        this._tweak_price([this.A, this.gamma], [this.balances[0], this.balances[1] * this.price_scale], p, 0, this.last_prices_timestamp + 3)
        return dx
    }

    _tweak_price(A_gamma: Array<number>, _xp: Array<number>, p_i: number, new_D: number, timestamp: number) {
        let price_oracle: number = this.price_oracle
        let last_prices: number = this.last_prices
        const price_scale: number = this.price_scale
        const last_prices_timestamp: number = this.last_prices_timestamp
        let p_new: number = 0

        if (last_prices_timestamp < timestamp) {
            // MA update required
            const ma_half_time: number = this.ma_half_time
            const alpha: number = VammJS._halfpow((timestamp - last_prices_timestamp) / ma_half_time)
            price_oracle = (last_prices * (1 - alpha) + price_oracle * alpha)
            this.price_oracle = price_oracle
            this.last_prices_timestamp = timestamp
        }

        let D_unadjusted: number = new_D // Withdrawal methods know new D already
        if (new_D == 0) {
            D_unadjusted = newton_D(A_gamma[0], A_gamma[1], _xp)
        }

        if (p_i > 0) {
            last_prices = p_i
        } else {
            // calculate real prices
            const __xp: Array<number> = _xp
            let dx_price: number = __xp[0] / 10**6
            __xp[0] += dx_price
            last_prices = price_scale * dx_price / (_xp[1] - newton_y(A_gamma[0], A_gamma[1], __xp, D_unadjusted, 1))
        }
        this.last_prices = last_prices

        const total_supply: number = this.totalSupply
        const old_xcp_profit: number = this.xcp_profit
        let old_virtual_price: number = this.virtual_price

        // Update profit numbers without price adjustment first
        let xp: Array<number> = [D_unadjusted / N_COINS, D_unadjusted / (N_COINS * price_scale)]
        let xcp_profit: number = 1
        let virtual_price: number = 1

        if (old_virtual_price > 0) {
            const xcp: number = geometricMean(xp)
            virtual_price = xcp / total_supply
            xcp_profit = old_xcp_profit * virtual_price / old_virtual_price
            if (virtual_price < old_virtual_price) throw 'Loss'
        }

        this.xcp_profit = xcp_profit

        let norm: number = price_oracle / price_scale
        if (norm > 1) norm -= 1
        else norm = 1 - norm

        const adjustment_step: number = Math.max(this.adjustment_step, norm/10)

        let needs_adjustment: boolean = this.not_adjusted
        // if not needs_adjustment && (virtual_price-10**18 > (xcp_profit-10**18)/2 + this.allowed_extra_profit):
        // (re-arrange for gas efficiency)
        if (
            !needs_adjustment
            && (virtual_price * 2 - 1 > xcp_profit + 2*this.allowed_extra_profit)
            && (norm > adjustment_step)
            && old_virtual_price > 0
        ) {
            needs_adjustment = true
            this.not_adjusted = true
        }

        if (needs_adjustment && norm > adjustment_step && old_virtual_price > 0) {
            p_new = (price_scale * (norm - adjustment_step) + adjustment_step * price_oracle) / norm

            // Calculate balances*prices
            xp = [_xp[0], _xp[1] * p_new / price_scale]

            // Calculate "extended constant product" invariant xCP && virtual price
            const D: number = newton_D(A_gamma[0], A_gamma[1], xp)
            xp = [D / N_COINS, D / (N_COINS * p_new)]
            // We reuse old_virtual_price here but it's not old anymore
            old_virtual_price = geometricMean(xp) / total_supply

            // Proceed if we've got enough profit
            // if (old_virtual_price > 10**18) && (2 * (old_virtual_price - 10**18) > xcp_profit - 10**18):
            if (old_virtual_price > 1 && (2 * old_virtual_price - 1 > xcp_profit)) {
                this.price_scale = p_new
                this.D = D
                this.virtual_price = old_virtual_price
                return
            } else {
                this.not_adjusted = false
                // Can instead do another flag variable if we want to save bytespace
                this.D = D_unadjusted
                this.virtual_price = virtual_price
                return
            }
        }

        // If we are here, the price_scale adjustment did not happen
        // Still need to update the profit counter && D
        this.D = D_unadjusted
        this.virtual_price = virtual_price

        // norm appeared < adjustment_step after
        if (needs_adjustment) this.not_adjusted = false
    }

    get_maker_position(amount: number, vUSD: number, vAsset: number, makerDToken: number) {
        const { position: makerPosSize, openNotional: makerOpenNotional, feeAdjustedPnl, D, balances } = this._get_maker_position(amount, vUSD, vAsset, makerDToken)
        let { unrealizedPnl } = this._get_taker_notional_and_pnl(makerPosSize, makerOpenNotional, balances, D)
        unrealizedPnl += feeAdjustedPnl
        return { position: makerPosSize, openNotional: makerOpenNotional, unrealizedPnl }
    }

    _get_maker_position(amount: number, vUSD: number, vAsset: number, makerDToken: number) {
        if (!amount) {
            return { position: 0, openNotional: 0, feeAdjustedPnl: 0, D: this.D, balances: this.balances.slice() }
        }

        const total_supply: number = this.totalSupply
        const balances = this.balances.slice()
        let D = this.D

        let position: number = 0
        let openNotional: number = 0
        let feeAdjustedPnl: number = 0

        // the following leads to makers taking a slightly bigger position, hence commented out from original code
        // amount: number = amount - 1  // Make rounding errors favoring other LPs a tiny bit
        const d_balances = new Array(N_COINS)
        for (let x = 0; x < N_COINS; x++) {
            d_balances[x] = balances[x] * amount / total_supply
            balances[x] -= d_balances[x]
        }
        D = D - D * amount / total_supply

        position = d_balances[N_COINS-1]
        let _vUSD = vUSD
        if (amount == makerDToken) {
            position -= vAsset
        } else {
            _vUSD = vUSD * amount / makerDToken
            position -= (vAsset * amount / makerDToken)
        }

        if (position > 0) {
            openNotional =  _vUSD - d_balances[0]
        } else if (position <= 0) {
            // =0 when no position open but positive openNotional due to fee accumulation
            openNotional = d_balances[0] - _vUSD
        }

        ;({ unrealizedPnl: feeAdjustedPnl, openNotional } = VammJS._get_fee_adjusted_pnl(position, openNotional))
        return { position, openNotional, feeAdjustedPnl, D, balances }
    }

    _get_taker_notional_and_pnl(position: number, openNotional: number, balances, D: number) {
        let notionalPosition: number = 0
        let unrealizedPnl: number = 0
        // console.log({ position, openNotional, balances, D })
        if (D > 0.1 - 10**-18) {
            if (position > 0) {
                notionalPosition = this.get_dy(position, balances, D)[0]
                unrealizedPnl = notionalPosition - openNotional
            } else if (position < 0) {
                const _pos = -position
                if (_pos > balances[N_COINS-1]) { // vamm doesn't have enough to sell _pos quantity of base asset
                    // @atul to think more deeply about this
                    notionalPosition = 0
                } else {
                    notionalPosition = this.get_dx(_pos, balances, D)[0]
                    // console.log({ notionalPosition })
                    unrealizedPnl = openNotional - notionalPosition
                }
            }
        }
        // console.log('_get_taker_notional_and_pnl', { unrealizedPnl })
        return { notionalPosition, unrealizedPnl }
    }

    vars() {
        return {
            balances: this.balances.slice(),
            price_scale: this.price_scale,
            price_oracle: this.price_oracle,
            last_prices: this.last_prices,
            ma_half_time: this.ma_half_time,
            totalSupply: this.totalSupply,
            xcp_profit: this.xcp_profit,
            virtual_price: this.virtual_price,
            adjustment_step: this.adjustment_step,
            allowed_extra_profit: this.allowed_extra_profit,
            not_adjusted: this.not_adjusted,
            D: this.D
        }
    }

    static _get_fee_adjusted_pnl(makerPosSize: number, makerOpenNotional: number) {
        let unrealizedPnl: number = 0
        let openNotional: number = makerOpenNotional

        if (makerOpenNotional < 0) {
            if (makerPosSize > 0) { // profit while removing liquidity
                unrealizedPnl = -makerOpenNotional
            } else if (makerPosSize < 0) { // loss while removing liquidity
                unrealizedPnl = makerOpenNotional
            }
            openNotional = 0
        } else if (makerOpenNotional > 0 && makerPosSize == 0) { // when all positions are balanced but profit due to fee accumulation
            unrealizedPnl = makerOpenNotional
            openNotional = 0
        }
        return { unrealizedPnl, openNotional }
    }

    static _halfpow(power: number) {
        return Math.pow(0.5, power)
    }
}

export async function getVammJS(vamm) {
    const types = new Array(11).fill('uint').concat(['bool', 'uint'])
    const vars = ethers.utils.defaultAbiCoder.decode(types, await vamm.vars({ gasLimit: 1e6 }))
    // init vammJS
    return new VammJS(
        [ bnToFloat(vars[0], 6), bnToFloat(vars[1], 18) ], // balances
        bnToFloat(vars[2], 18), // price_scale
        bnToFloat(vars[3], 18), // price_oracle
        bnToFloat(vars[4], 18), // last_prices
        parseFloat(vars[5]), // ma_half_time=600
        bnToFloat(vars[6], 18), // totalSupply
        bnToFloat(vars[7], 18), // xcp_profit
        bnToFloat(vars[8], 18), // virtual_price
        bnToFloat(vars[9], 18), // adjustment_step
        bnToFloat(vars[10], 18), // allowed_extra_profit
        vars[11], // not_adjusted
        bnToFloat(vars[12], 18), // D
    )
}

function bnToFloat(num, decimals = 6) {
    return parseFloat(ethers.utils.formatUnits(num.toString(), decimals))
}

export function get_dy(i, j, dx, balances, D, priceScale, A, gamma, midFee) {
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
    const { markPrice } = calcMarkPrice(xp[0], xp[1], A, gamma, DNew, priceScale)
    return [dy, fee, markPrice];
}

export function get_dx(i, j, dy, balances, D, priceScale, A, gamma, midFee) {
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
    const { markPrice } = calcMarkPrice(xp[0], xp[1], A, gamma, DNew, priceScale)
    return [dx, fee, markPrice]
}

export function get_D(A, gamma, balances, priceScale) {
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

export function newton_D(ANN, gamma, x_unsorted) {
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

export function calcMarkPrice(x, y, A, gamma, D, priceScale) {
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
    return {
        markPrice: Math.abs(priceScale/yPrime),
        K0
    }
}

export function geometricMean(x) {
    return Math.sqrt(x[0]*x[1])
}
