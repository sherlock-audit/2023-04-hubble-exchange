// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { ERC20PresetMinterPauser } from "@openzeppelin/contracts/token/ERC20/presets/ERC20PresetMinterPauser.sol";
import { VUSD } from "../VUSD.sol";

contract ERC20Mintable is ERC20PresetMinterPauser {

    uint8 _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20PresetMinterPauser(name_, symbol_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}

contract RestrictedErc20 is ERC20Mintable {
    bytes32 public constant TRANSFER_ROLE = keccak256("TRANSFER_ROLE");

    bool public transfersAllowed;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20Mintable(name_, symbol_, decimals_) {}

    function allowTransfers() external {
        require(hasRole(DEFAULT_ADMIN_ROLE, _msgSender()), "HubbleErc20.allowTransfers.noAuth");
        transfersAllowed = true;
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override /* (ERC20, ERC20Pausable) */ {
        super._beforeTokenTransfer(from, to, amount);
        require(
            transfersAllowed ||
            from == address(0) || // mints are allowed, ACLed on MINTER_ROLE or internal _mint
            hasRole(TRANSFER_ROLE, from) ||
            hasRole(TRANSFER_ROLE, to),
            "HubbleErc20.transfersDisabled"
        );
    }
}

contract RestrictedVusd is VUSD {
    bytes32 public constant TRANSFER_ROLE = keccak256("TRANSFER_ROLE");

    bool public transfersAllowed;

    function initialize(string memory name, string memory symbol) public override {
        super.initialize(name, symbol);
        _grantRole(MINTER_ROLE, _msgSender());
    }

    function allowTransfers() external {
        require(hasRole(DEFAULT_ADMIN_ROLE, _msgSender()), "HubbleErc20.allowTransfers.noAuth");
        transfersAllowed = true;
    }

    function grantRoles(bytes32[] calldata roles, address[] calldata accounts) external {
        require(roles.length == accounts.length, "Invalid");
        for (uint i; i < roles.length; i++) {
            grantRole(roles[i], accounts[i]);
        }
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override /* (ERC20, ERC20Pausable) */ {
        super._beforeTokenTransfer(from, to, amount);
        require(
            transfersAllowed ||
            from == address(0) || // mints are allowed, ACLed on MINTER_ROLE or internal _mint
            hasRole(TRANSFER_ROLE, from) ||
            hasRole(TRANSFER_ROLE, to),
            "RestrictedVusd.transfersDisabled"
        );
    }
}
