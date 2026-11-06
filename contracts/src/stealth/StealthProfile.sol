// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title StealthProfile
/// @notice The postcurve pq-sap account profile `postcurve-wots-xmss-quorum/v0` (spec/stealth-profile.md):
///         the quorum's spend key and the per-payment commitment a stealth account is built around.
library StealthProfile {
    /// @notice One approver's hash-only identity (spec/signature.md).
    struct Identity {
        bytes32 root;
        bytes32 pubSeed;
    }

    bytes internal constant KEY_DOMAIN = "postcurve/quorum/key/v0";
    bytes internal constant COMMIT_DOMAIN = "postcurve/wots-xmss-quorum/commit/v0";

    /// @notice spend_key = keccak256(key domain || abi.encode(threshold, identities)). Order matters.
    function spendKey(uint256 threshold, Identity[] memory ids) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(KEY_DOMAIN, abi.encode(threshold, ids)));
    }

    /// @notice commitment = keccak256(commit domain || spend_key || opener), as in pq-sap's format 0x02.
    function commitment(bytes32 spendKey_, bytes32 opener) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(COMMIT_DOMAIN, spendKey_, opener));
    }

    /// @notice The key a register of used one-time keys is indexed by.
    function identityHash(Identity memory id) internal pure returns (bytes32) {
        return keccak256(abi.encode(id.root, id.pubSeed));
    }
}
