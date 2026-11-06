// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal ERC-5564 announcer, interface-identical to the singleton deployed on mainnet, for the
///         local devnet. Vendored from Skanislav/pq-sap (js-client/contracts/src/ERC5564Announcer.sol at
///         dd18e5f), MIT License, Copyright (c) 2026 Skas Merkushin.
contract ERC5564Announcer {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external
    {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}
