// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IFrameOps} from "./FrameOps.sol";
import {StealthBunkerAccount} from "./StealthBunkerAccount.sol";

/// @title StealthBunkerFactory
/// @notice Deploys stealth accounts at pq-sap's CREATE2 address:
///         keccak256(0xff || factory || 0 || keccak256(creationCode || abi.encode(commitment, paymaster, frameOps))).
///         A deploy frame calls `deploy` on the first spend. No state, no admin.
contract StealthBunkerFactory {
    address public immutable PAYMASTER;
    IFrameOps public immutable FRAME_OPS;

    constructor(address paymaster, IFrameOps frameOps) {
        PAYMASTER = paymaster;
        FRAME_OPS = frameOps;
    }

    function addressOf(bytes32 commitment) public view returns (address) {
        bytes32 initHash = keccak256(
            abi.encodePacked(type(StealthBunkerAccount).creationCode, abi.encode(commitment, PAYMASTER, FRAME_OPS))
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(0), initHash)))));
    }

    /// @notice Idempotent: returns the existing account if it's already deployed.
    function deploy(bytes32 commitment) external returns (address account) {
        account = addressOf(commitment);
        if (account.code.length == 0) {
            account = address(new StealthBunkerAccount{salt: bytes32(0)}(commitment, PAYMASTER, FRAME_OPS));
        }
    }
}
