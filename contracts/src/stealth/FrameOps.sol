// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {HelperCode} from "@forshtat/hegota-support/contracts/generated/HelperCode.sol";
import {HelperCalls} from "@forshtat/hegota-support/contracts/internal/HelperCalls.sol";
import {FrameParam, Scope, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";

/// @notice Where the shared EIP-8141 opcode helpers live. Solidity can't emit the frame opcodes, so
///         each is a tiny Yul contract from the hegota-support package (MIT).
interface IFrameOps {
    function approveHelper() external view returns (address);
    function txParamHelper() external view returns (address);
    function frameParamHelper() external view returns (address);
    function frameDataCopyHelper() external view returns (address);
}

/// @title FrameOps
/// @notice Deploys the opcode helpers once, so every stealth account can use them without deploying
///         its own (hegota-support's HegotaSupport base deploys a set per contract). No state, no admin.
contract FrameOps is IFrameOps {
    address public immutable approveHelper;
    address public immutable txParamHelper;
    address public immutable frameParamHelper;
    address public immutable frameDataCopyHelper;

    error HelperDeploymentFailed();

    constructor() {
        approveHelper = _deploy(HelperCode.approve(Devnet.ERC8421_WORKSHOP));
        txParamHelper = _deploy(HelperCode.txParam(Devnet.ERC8421_WORKSHOP));
        frameParamHelper = _deploy(HelperCode.frameParam(Devnet.ERC8421_WORKSHOP));
        frameDataCopyHelper = _deploy(HelperCode.frameDataCopy(Devnet.ERC8421_WORKSHOP));
    }

    function _deploy(bytes memory code) private returns (address helper) {
        assembly ("memory-safe") {
            helper := create(0, add(code, 0x20), mload(code))
        }
        if (helper == address(0)) revert HelperDeploymentFailed();
    }
}

/// @notice The frame opcodes as functions on an IFrameOps. Reads use staticcall; APPROVE uses
///         delegatecall, so it approves on behalf of the calling contract and ends its frame.
library FrameOpsLib {
    function txParam(IFrameOps ops, TxParam param) internal view returns (uint256) {
        return HelperCalls.readWord(ops.txParamHelper(), abi.encode(param));
    }

    function frameParam(IFrameOps ops, uint256 frameIndex, FrameParam param) internal view returns (uint256) {
        return HelperCalls.readWord(ops.frameParamHelper(), abi.encode(frameIndex, param));
    }

    function frameTarget(IFrameOps ops, uint256 frameIndex) internal view returns (address) {
        return address(uint160(frameParam(ops, frameIndex, FrameParam.RESOLVED_TARGET)));
    }

    function frameData(IFrameOps ops, uint256 offset, uint256 length, uint256 frameIndex)
        internal
        view
        returns (bytes memory)
    {
        return HelperCalls.read(ops.frameDataCopyHelper(), abi.encode(offset, length, frameIndex));
    }

    function approve(IFrameOps ops, Scope scope) internal {
        HelperCalls.act(ops.approveHelper(), abi.encode(scope));
    }
}
