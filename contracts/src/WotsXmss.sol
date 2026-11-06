// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title WotsXmss
/// @notice Verifies one postcurve v1 hash-only signature: a WOTS (w = 16) one-time signature
///         under an XMSS tree of height 8, all over keccak256. Normative format:
///         spec/signature.md. Plain Solidity on purpose: this version is the reference and the
///         gas baseline.
library WotsXmss {
    /// @notice What the account stores for one approver.
    struct Identity {
        bytes32 root;
        bytes32 pubSeed;
    }

    uint256 internal constant LEN1 = 64;
    uint256 internal constant LEN = 67;
    uint256 internal constant CHAIN_MAX = 15;
    uint256 internal constant HEIGHT = 8;
    uint256 internal constant LEAVES = 256;
    uint256 internal constant ENVELOPE_BYTES = 2432; // 32 * (1 + 67 + 8)
    uint256 internal constant SIG_OFFSET = 32;
    uint256 internal constant AUTH_OFFSET = 32 + 67 * 32;

    uint256 internal constant DOMAIN_CHAIN = 3;
    uint256 internal constant DOMAIN_LEAF = 4;
    uint256 internal constant DOMAIN_NODE = 5;

    /// @notice Checks `envelope` = abi.encode(uint256 leaf, bytes32[67] sig, bytes32[8] auth)
    ///         as a signature of `digest` by `id`. Never reverts on malformed input.
    /// @return ok   true iff the signature is valid
    /// @return leaf the one-time key index used (0 when !ok)
    function verify(Identity memory id, bytes32 digest, bytes calldata envelope)
        internal
        pure
        returns (bool ok, uint256 leaf)
    {
        if (envelope.length != ENVELOPE_BYTES) return (false, 0);
        uint256 l = uint256(bytes32(envelope[0:32]));
        if (l >= LEAVES) return (false, 0);

        bytes32[LEN] memory pk;
        uint256 csum;
        for (uint256 j = 0; j < LEN1; j++) {
            uint8 b = uint8(digest[j >> 1]);
            uint256 digit = (j & 1 == 0) ? b >> 4 : b & 0x0f;
            csum += CHAIN_MAX - digit;
            pk[j] = _chainUp(id.pubSeed, l, j, digit, _word(envelope, SIG_OFFSET + 32 * j));
        }
        uint256[3] memory c = [(csum >> 8) & 0x0f, (csum >> 4) & 0x0f, csum & 0x0f];
        for (uint256 t = 0; t < 3; t++) {
            uint256 j = LEN1 + t;
            pk[j] = _chainUp(id.pubSeed, l, j, c[t], _word(envelope, SIG_OFFSET + 32 * j));
        }

        bytes32 node = keccak256(abi.encode(DOMAIN_LEAF, id.pubSeed, l, pk));
        uint256 i = l;
        for (uint256 k = 0; k < HEIGHT; k++) {
            bytes32 sibling = _word(envelope, AUTH_OFFSET + 32 * k);
            uint256 address_ = ((k + 1) << 32) | (i >> 1);
            node = (i & 1 == 0)
                ? keccak256(abi.encode(DOMAIN_NODE, id.pubSeed, address_, node, sibling))
                : keccak256(abi.encode(DOMAIN_NODE, id.pubSeed, address_, sibling, node));
            i >>= 1;
        }

        if (node != id.root) return (false, 0);
        return (true, l);
    }

    /// @dev Walks chain j of leaf l from position `start` to the public end (position 15).
    function _chainUp(bytes32 pubSeed, uint256 l, uint256 j, uint256 start, bytes32 x) private pure returns (bytes32) {
        for (uint256 s = start; s < CHAIN_MAX; s++) {
            x = keccak256(abi.encode(DOMAIN_CHAIN, pubSeed, (l << 16) | (j << 8) | s, x));
        }
        return x;
    }

    function _word(bytes calldata data, uint256 offset) private pure returns (bytes32) {
        return bytes32(data[offset:offset + 32]);
    }
}
