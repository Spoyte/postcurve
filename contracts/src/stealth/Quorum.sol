// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StealthProfile} from "./StealthProfile.sol";
import {WotsXmss} from "../WotsXmss.sol";

/// @title Quorum
/// @notice Checks a threshold of hash-only (WOTS/XMSS) approvals over one digest. Shared by the
///         paymaster's main path and the account's emergency path. Callers check and record the
///         returned one-time keys against their registers.
library Quorum {
    error LengthMismatch();
    error ThresholdNotMet(uint256 threshold, uint256 given);
    error SignerOutOfRange(uint256 index);
    error SignersNotStrictlyIncreasing(uint256 position);
    error InvalidApproval(uint256 position);

    /// @param signerIdx positions in `ids`, strictly increasing so no approver counts twice.
    /// @return idHashes identityHash of each signer; leaves the one-time key each one used.
    function verify(
        StealthProfile.Identity[] calldata ids,
        uint256 threshold,
        uint256[] calldata signerIdx,
        bytes[] calldata envelopes,
        bytes32 digest
    ) internal pure returns (bytes32[] memory idHashes, uint256[] memory leaves) {
        uint256 n = signerIdx.length;
        if (envelopes.length != n) revert LengthMismatch();
        if (threshold == 0 || n < threshold) revert ThresholdNotMet(threshold, n);
        idHashes = new bytes32[](n);
        leaves = new uint256[](n);
        for (uint256 k = 0; k < n; k++) {
            uint256 idx = signerIdx[k];
            if (idx >= ids.length) revert SignerOutOfRange(idx);
            if (k > 0 && idx <= signerIdx[k - 1]) revert SignersNotStrictlyIncreasing(k);
            StealthProfile.Identity calldata id = ids[idx];
            (bool ok, uint256 leaf) = WotsXmss.verify(WotsXmss.Identity(id.root, id.pubSeed), digest, envelopes[k]);
            if (!ok) revert InvalidApproval(k);
            idHashes[k] = keccak256(abi.encode(id.root, id.pubSeed));
            leaves[k] = leaf;
        }
    }
}
