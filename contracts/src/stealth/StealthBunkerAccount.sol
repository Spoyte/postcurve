// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {FrameMode, FrameParam, Scope, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {FrameOpsLib, IFrameOps} from "./FrameOps.sol";
import {Quorum} from "./Quorum.sol";
import {StealthProfile} from "./StealthProfile.sol";
import {TransferApproval} from "./TransferApproval.sol";

/// @notice The paymaster's register of one-time keys it has accepted.
interface IPostcurvePaymaster {
    function isLeafUsed(bytes32 identityHash, uint256 leaf) external view returns (bool);
}

/// @title StealthBunkerAccount
/// @notice A fresh EIP-8141 account per stealth payment (spec/stealth-profile.md). No elliptic-curve
///         key can move its funds. Its constructor arguments are pq-sap's deployment binding
///         (commitment, verifier = the postcurve paymaster, frame context = shared opcode helpers), so
///         a sender can compute its address before it exists. Immutable: no owner, admin or upgrade.
///
///         Main path: `verifyExecution` is the `only_verify` frame. It only checks that the paymaster
///         bound here pays (its `pay` frame verifies the quorum), records the one-time keys (`commit`) and
///         checks the deadline (`checkDeadline`), and that execution is two token transfers; the paymaster
///         checks signatures and details.
///         Emergency path: `emergencyExecute` verifies the quorum itself, for when the paymaster is
///         unavailable. It costs privacy (someone must sponsor the gas), never funds.
contract StealthBunkerAccount {
    using FrameOpsLib for IFrameOps;
    using SafeERC20 for IERC20;

    address public constant ENTRY_POINT = address(0xaa);

    bytes32 public immutable COMMITMENT;
    address public immutable PAYMASTER;
    IFrameOps public immutable FRAME_OPS;

    /// @dev One-time keys spent through the emergency path.
    mapping(bytes32 identityHash => mapping(uint256 leaf => bool)) private _usedHere;

    struct EmergencyAuth {
        uint256 threshold;
        StealthProfile.Identity[] ids;
        bytes32 opener;
        TransferApproval.Data approval;
        uint256[] signerIdx;
        bytes[] envelopes;
    }

    event EmergencySpend(address indexed token, address indexed to, uint256 amount);

    error NotEntryPoint(address caller);
    error BadFrameShape(uint256 check);
    error NotAuthorized(uint256 reason);

    constructor(bytes32 commitment_, address paymaster_, IFrameOps frameOps_) {
        COMMITMENT = commitment_;
        PAYMASTER = paymaster_;
        FRAME_OPS = frameOps_;
    }

    receive() external payable {}

    /// @notice `only_verify`: approves execution only for [.., only_verify(this), pay(PAYMASTER),
    ///         commit(PAYMASTER), checkDeadline(PAYMASTER), sender(token), sender(token)].
    function verifyExecution() external {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint(msg.sender);
        uint256 i = FRAME_OPS.txParam(TxParam.CURRENT_FRAME_INDEX);
        if (FRAME_OPS.txParam(TxParam.FRAME_COUNT) != i + 6) revert BadFrameShape(1);
        if (_mode(i + 1) != FrameMode.VERIFY || FRAME_OPS.frameTarget(i + 1) != PAYMASTER) revert BadFrameShape(2);
        if (_mode(i + 2) != FrameMode.DEFAULT || FRAME_OPS.frameTarget(i + 2) != PAYMASTER) revert BadFrameShape(3);
        if (_mode(i + 3) != FrameMode.DEFAULT || FRAME_OPS.frameTarget(i + 3) != PAYMASTER) revert BadFrameShape(6);
        address token = FRAME_OPS.frameTarget(i + 4);
        if (_mode(i + 4) != FrameMode.SENDER || _mode(i + 5) != FrameMode.SENDER) revert BadFrameShape(4);
        if (FRAME_OPS.frameTarget(i + 5) != token) revert BadFrameShape(5);
        FRAME_OPS.approve(Scope.EXECUTION);
    }

    /// @notice Emergency spend in a DEFAULT frame: the account checks the quorum itself.
    function emergencyExecute(EmergencyAuth calldata auth) external {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint(msg.sender);
        TransferApproval.Data calldata a = auth.approval;
        if (a.maxFee != 0) revert NotAuthorized(1);
        if (block.timestamp > a.validUntil) revert NotAuthorized(2);
        if (StealthProfile.commitment(StealthProfile.spendKey(auth.threshold, auth.ids), auth.opener) != COMMITMENT) {
            revert NotAuthorized(3);
        }
        bytes32 digest = TransferApproval.digest(a, block.chainid, address(this));
        (bytes32[] memory idHashes, uint256[] memory leaves) =
            Quorum.verify(auth.ids, auth.threshold, auth.signerIdx, auth.envelopes, digest);
        for (uint256 k = 0; k < leaves.length; k++) {
            if (_usedHere[idHashes[k]][leaves[k]] || IPostcurvePaymaster(PAYMASTER).isLeafUsed(idHashes[k], leaves[k]))
            {
                revert NotAuthorized(4);
            }
            _usedHere[idHashes[k]][leaves[k]] = true;
        }
        IERC20(a.token).safeTransfer(a.to, a.amount);
        emit EmergencySpend(a.token, a.to, a.amount);
    }

    /// @notice One-time keys spent through the emergency path; the paymaster checks these too.
    function isLeafUsedHere(bytes32 identityHash, uint256 leaf) external view returns (bool) {
        return _usedHere[identityHash][leaf];
    }

    function _mode(uint256 frameIndex) private view returns (FrameMode) {
        return FrameMode(FRAME_OPS.frameParam(frameIndex, FrameParam.MODE));
    }
}
