// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC
/// @notice A local-devnet test token with USDC's 6 decimals. It is not USDC and has no value.
///         Only the deployer can mint.
contract TestUSDC is ERC20 {
    address public immutable MINTER;

    error NotMinter(address caller);

    constructor() ERC20("Test USDC (postcurve local)", "tUSDC") {
        MINTER = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != MINTER) revert NotMinter(msg.sender);
        _mint(to, amount);
    }
}
