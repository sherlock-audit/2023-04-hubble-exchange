
# [project name] contest details

- Join [Sherlock Discord](https://discord.gg/MABEWyASkp)
- Submit findings using the issue page in your private contest repo (label issues as med or high)
- [Read for more details](https://docs.sherlock.xyz/audits/watsons)

# Q&A

### Q: On what chains are the smart contracts going to be deployed?
A EVM cmpatible app-chain
___

### Q: Which ERC20 tokens do you expect will interact with the smart contracts? 
- USDC (also the gas token on the app-chain)

- VUSD/hUSD - Our own ERC20 which is the custom unit of accounting in all of Hubble

- Later some others as supported collateral in Margin Account
___

### Q: Which ERC721 tokens do you expect will interact with the smart contracts? 
None
___

### Q: Which ERC777 tokens do you expect will interact with the smart contracts? 
None
___

### Q: Are there any FEE-ON-TRANSFER tokens interacting with the smart contracts?

No
___

### Q: Are there any REBASING tokens interacting with the smart contracts?

No
___

### Q: Are the admins of the protocols your contracts integrate with (if any) TRUSTED or RESTRICTED?
TRUSTED
___

### Q: Is the admin/owner of the protocol/contracts TRUSTED or RESTRICTED?
TRUSTED
___

### Q: Are there any additional protocol roles? If yes, please explain in detail:
1. There is a governance role.
2. It basically refers to team multisig can update the system configuration parameters.
3. Same as above
4. N/A
___

### Q: Is the code/contract expected to comply with any EIPs? Are there specific assumptions around adhering to those EIPs that Watsons should be aware of?
No
___

### Q: Please list any known issues/acceptable risks that should not result in a valid finding.
Things marked as @todo within the codebase
___

### Q: Please provide links to previous audits (if any).
audits for the v1 (which has some common parts) - https://www.notion.so/hubbleexchange/Sherlock-Audit-Brief-974c91994103458cae91bb28ac5c9df7?pvs=4#9b112d9e59e942be87404f5bb33ad410
___

### Q: Are there any off-chain mechanisms or off-chain procedures for the protocol (keeper bots, input validation expectations, etc)?
Decentralization of the Matching Engine

In Hubble Exchange, the Decentralized Limit Order Book and Matching Engine are embedded within the block-building process of the app-chain. As users place orders, the orders are confirmed and indexed locally in the validator node, which also maintains all information about open positions, margins, pending funding, and margin ratio.

When a validator is selected as the block producer, the buildBlock function fetches active markets and open orders from the indexer, evaluates open positions for potential liquidations, runs the matching engine, and then relays these operations as local transactions before continuing the normal transaction bundling process.

This system ensures that order matching is as decentralized as the validator set of the hubblenet, resulting in a truly decentralized orderbook and matching engine.
___

### Q: In case of external protocol integrations, are the risks of external contracts pausing or executing an emergency withdrawal acceptable? If not, Watsons will submit issues related to these situations that can harm your protocol's functionality.
Yes, open to scenarios where disruption in layer0 service might be able to cause us a big damage, if any.
___



# Audit scope


[foundry-test @ 19e0ae4b3d4afa101862d7484824075c6489a49b](https://github.com/frimoldi/foundry-test/tree/19e0ae4b3d4afa101862d7484824075c6489a49b)
- [foundry-test/script/Counter.s.sol](foundry-test/script/Counter.s.sol)
- [foundry-test/src/Counter.sol](foundry-test/src/Counter.sol)
- [foundry-test/test/Counter.t.sol](foundry-test/test/Counter.t.sol)


