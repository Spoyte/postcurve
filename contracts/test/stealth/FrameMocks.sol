// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IFrameOps} from "../../src/stealth/FrameOps.sol";
import {StealthProfile} from "../../src/stealth/StealthProfile.sol";

/// The test EVM has no frame opcodes. These stand in for the hegota-support helpers that FrameOps
/// points at, with the same calldata convention (operands as consecutive words, no selector).

contract MockTxParam {
    mapping(uint256 => uint256) public value;

    function put(uint256 param, uint256 v) external {
        value[param] = v;
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        return abi.encode(value[abi.decode(input, (uint256))]);
    }
}

contract MockFrameParam {
    mapping(uint256 => mapping(uint256 => uint256)) public value;

    function put(uint256 frameIndex, uint256 param, uint256 v) external {
        value[frameIndex][param] = v;
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        (uint256 frameIndex, uint256 param) = abi.decode(input, (uint256, uint256));
        return abi.encode(value[frameIndex][param]);
    }
}

contract MockFrameDataCopy {
    mapping(uint256 => bytes) public data;

    function put(uint256 frameIndex, bytes calldata d) external {
        data[frameIndex] = d;
    }

    fallback(bytes calldata input) external returns (bytes memory out) {
        (uint256 offset, uint256 length, uint256 frameIndex) = abi.decode(input, (uint256, uint256, uint256));
        bytes storage d = data[frameIndex];
        out = new bytes(length);
        for (uint256 i = 0; i < length && offset + i < d.length; i++) {
            out[i] = d[offset + i];
        }
    }
}

/// Runs by delegatecall, so the event comes from the approving contract.
contract MockApprove {
    event Approved(uint256 scope);

    fallback(bytes calldata input) external returns (bytes memory) {
        emit Approved(abi.decode(input, (uint256)));
        return "";
    }
}

contract MockFrameOps is IFrameOps {
    address public immutable approveHelper;
    address public immutable txParamHelper;
    address public immutable frameParamHelper;
    address public immutable frameDataCopyHelper;

    constructor() {
        approveHelper = address(new MockApprove());
        txParamHelper = address(new MockTxParam());
        frameParamHelper = address(new MockFrameParam());
        frameDataCopyHelper = address(new MockFrameDataCopy());
    }
}

/// Shared helpers for building frame layouts and signing in tests.
abstract contract FrameTestBase is Test {
    // hegota-support enum values
    uint256 internal constant MODE_DEFAULT = 0;
    uint256 internal constant MODE_VERIFY = 1;
    uint256 internal constant MODE_SENDER = 2;
    uint256 internal constant TX_SENDER = 2;
    uint256 internal constant TX_SIG_HASH = 8;
    uint256 internal constant TX_FRAME_COUNT = 9;
    uint256 internal constant TX_CURRENT_FRAME_INDEX = 10;
    uint256 internal constant FP_TARGET = 0;
    uint256 internal constant FP_MODE = 2;
    uint256 internal constant FP_FLAGS = 3;
    uint256 internal constant FP_DATA_LENGTH = 4;
    uint256 internal constant FP_STATUS = 5;
    uint256 internal constant TX_MAX_COST = 6;
    uint256 internal constant FP_EXECUTION_GAS_LIMIT = 1;
    uint256 internal constant FP_VALUE = 8;
    uint256 internal constant FP_STATE_GAS_LIMIT = 9;
    uint256 internal constant FLAG_ATOMIC = 4;
    uint256 internal constant SCOPE_PAYMENT = 1;
    uint256 internal constant SCOPE_EXECUTION = 2;

    event Approved(uint256 scope);

    MockFrameOps internal ops;
    string internal vectors;

    function setUpFrames() internal {
        ops = new MockFrameOps();
        vectors = vm.readFile("../spec/vectors/stealth-v0.json");
    }

    function txp(uint256 param, uint256 v) internal {
        MockTxParam(ops.txParamHelper()).put(param, v);
    }

    function frame(uint256 index, uint256 mode, address target) internal {
        MockFrameParam(ops.frameParamHelper()).put(index, FP_MODE, mode);
        MockFrameParam(ops.frameParamHelper()).put(index, FP_TARGET, uint256(uint160(target)));
    }

    function frameFlags(uint256 index, uint256 flags) internal {
        MockFrameParam(ops.frameParamHelper()).put(index, FP_FLAGS, flags);
    }

    function frameParamSet(uint256 index, uint256 param, uint256 v) internal {
        MockFrameParam(ops.frameParamHelper()).put(index, param, v);
    }

    function frameStatus(uint256 index, uint256 status) internal {
        MockFrameParam(ops.frameParamHelper()).put(index, FP_STATUS, status);
    }

    function frameData(uint256 index, bytes memory d) internal {
        MockFrameDataCopy(ops.frameDataCopyHelper()).put(index, d);
    }

    function testIds() internal view returns (StealthProfile.Identity[] memory out) {
        out = new StealthProfile.Identity[](3);
        for (uint256 i = 0; i < 3; i++) {
            string memory p = string.concat(".identities[", vm.toString(i), "]");
            out[i] = StealthProfile.Identity(
                vm.parseJsonBytes32(vectors, string.concat(p, ".root")),
                vm.parseJsonBytes32(vectors, string.concat(p, ".pubSeed"))
            );
        }
    }

    function testOpener() internal view returns (bytes32) {
        return vm.parseJsonBytes32(vectors, ".opener");
    }

    /// Signs `digest` as test approver `who` (1..3) at `leaf`, through the SDK (TEST seeds only).
    function sign(uint256 who, uint256 leaf, bytes32 digest) internal returns (bytes memory) {
        string[] memory cmd = new string[](5);
        cmd[0] = "bun";
        cmd[1] = "../sdk/scripts/ffi-sign-fixture.ts";
        cmd[2] = vm.toString(who);
        cmd[3] = vm.toString(leaf);
        cmd[4] = vm.toString(digest);
        return vm.ffi(cmd);
    }
}
