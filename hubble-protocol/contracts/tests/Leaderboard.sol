// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IClearingHouse, IMarginAccount, IAMM, IHubbleViewer } from "../Interfaces.sol";

contract Leaderboard {

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable marginAccount;
    IHubbleViewer  public immutable hubbleViewer;

    constructor(
        IHubbleViewer _hubbleViewer
    ) {
        clearingHouse = _hubbleViewer.clearingHouse();
        marginAccount = _hubbleViewer.marginAccount();
        hubbleViewer = _hubbleViewer;
    }

    function leaderboard(address[] calldata traders)
        external
        view
        returns(int[] memory pnls, int[] memory fundings)
    {
        uint numTraders = traders.length;
        pnls = new int[](numTraders);
        fundings = new int[](numTraders);

        uint l = clearingHouse.getAmmsLength();
        IAMM[] memory amms = new IAMM[](l);
        for (uint j = 0; j < l; j++) {
            amms[j] = clearingHouse.amms(j);
        }

        // loop over traders
        for (uint i; i < numTraders; i++) {
            (pnls[i], fundings[i]) = _calcUnrealizedPnL(traders[i], amms);
        }
    }

    function _calcUnrealizedPnL(address trader, IAMM[] memory amms)
        internal
        view
        returns(int unrealizedPnl, int takerFunding)
    {
        IAMM amm;
        int _unrealizedPnl;
        int _takerFunding;
        for (uint j = 0; j < amms.length; j++) {
            amm = amms[j];
            (,_unrealizedPnl) = amm.getNotionalPositionAndUnrealizedPnl(trader);
            (_takerFunding,) = amm.getPendingFundingPayment(trader);
            unrealizedPnl += _unrealizedPnl;
            takerFunding += _takerFunding;
        }
    }
}

