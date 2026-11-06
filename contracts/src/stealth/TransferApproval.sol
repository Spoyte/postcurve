// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title TransferApproval
/// @notice The EIP-712 v2 approval every approver signs for a stealth bunker spend: one token transfer
///         and a capped fee. Matches sdk/src/transferApproval.ts.
library TransferApproval {
    struct Data {
        uint256 nonce;
        address token;
        address to;
        uint256 amount;
        uint256 maxFee;
        uint64 validUntil;
    }

    bytes32 internal constant TYPEHASH = keccak256(
        "TransferApproval(uint256 nonce,address token,address to,uint256 amount,uint256 maxFee,uint64 validUntil)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("postcurve");
    bytes32 internal constant VERSION_HASH = keccak256("2");

    /// @param account the stealth account the approval is for (the EIP-712 verifyingContract).
    function digest(Data memory a, uint256 chainId, address account) internal pure returns (bytes32) {
        bytes32 domainSeparator = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, chainId, account));
        bytes32 structHash =
            keccak256(abi.encode(TYPEHASH, a.nonce, a.token, a.to, a.amount, a.maxFee, uint256(a.validUntil)));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
