// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FrameMode, FrameParam, Scope, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {FrameOpsLib, IFrameOps} from "./FrameOps.sol";
import {Quorum} from "./Quorum.sol";
import {StealthBunkerAccount, IPostcurvePaymaster} from "./StealthBunkerAccount.sol";
import {StealthBunkerFactory} from "./StealthBunkerFactory.sol";
import {StealthProfile} from "./StealthProfile.sol";
import {TransferApproval} from "./TransferApproval.sol";

interface IStakingRegistry {
    function addStake(uint32 unstakeDelaySec) external payable;
}

/// @title PostcurvePaymaster
/// @notice Pays the gas for a stealth bunker account's spend and takes its fee in the token being spent, so
///         the recipient never needs ETH from an address linked to them. As a staked entity under ERC-8421
///         its validation frame may use up to 1,000,000 gas, which carries the hash-only quorum check the
///         unstaked, freshly deployed account could not:
///
///         [only_verify: account] [pay: approvePayment] [commit] [checkDeadline: atomic] [transfer: atomic] [fee]
///
///         `approvePayment` (the VERIFY `pay` frame, a static call) checks everything and approves payment.
///         It can't write, so it requires the next frame to be `commit` for exactly the one-time keys it
///         verified, with enough gas to always finish. `commit` runs outside the atomic batch, so the keys
///         are recorded even when the transfers fail: an approval is used once whatever happens next.
///         `checkDeadline` opens the atomic batch and enforces the approval's `validUntil` (TIMESTAMP is
///         banned during validation, so the check runs in execution); if it fails, both transfers unroll.
///         `commit` only runs right after this paymaster's own successful `approvePayment`, and
///         `checkDeadline` only right after a successful `commit`.
///
///         What the paymaster agrees to pay is bounded: it sponsors spends of its fee token only, for at
///         least `MIN_FEE`, in transactions whose maximum ETH cost is at most `MAX_SPONSORED_WEI`, with no
///         ETH value in any frame and only when the account holds the amount plus the fee.
///         If the paymaster doesn't approve payment, the transaction is invalid and nothing executes.
///         Immutable: no owner or admin. It deploys its own factory so each knows the other.
contract PostcurvePaymaster is IPostcurvePaymaster {
    using FrameOpsLib for IFrameOps;

    address public constant ENTRY_POINT = address(0xaa);
    uint256 internal constant FRAME_SUCCESS = 1;
    uint256 internal constant ATOMIC_BATCH_FLAG = 0x04;
    uint32 internal constant UNSTAKE_DELAY = 86400;
    /// @notice Least gas the `commit` frame must carry, so it can always record the keys.
    uint256 public constant COMMIT_MIN_EXECUTION_GAS = 120_000;
    uint256 public constant COMMIT_MIN_STATE_GAS = 300_000;

    IFrameOps public immutable FRAME_OPS;
    StealthBunkerFactory public immutable FACTORY;
    address public immutable STAKING_REGISTRY;
    /// @notice The only token this paymaster takes its fee in, and so the only token whose spends it pays for.
    IERC20 public immutable FEE_TOKEN;
    /// @notice Least fee, in `FEE_TOKEN` base units, for one sponsored spend.
    uint256 public immutable MIN_FEE;
    /// @notice Most ETH one sponsored transaction may cost (TXPARAM MAX_COST).
    uint256 public immutable MAX_SPONSORED_WEI;

    mapping(bytes32 identityHash => mapping(uint256 leaf => bool)) private _used;

    struct SpendAuth {
        uint256 threshold;
        StealthProfile.Identity[] ids;
        bytes32 opener;
        TransferApproval.Data approval;
        uint256[] signerIdx;
        bytes[] envelopes;
        uint256 fee;
    }

    event KeysCommitted(address indexed account, uint256 count);

    error NotEntryPoint(address caller);
    error NotAStealthAccount(address sender);
    error Rejected(uint256 reason);

    constructor(IFrameOps frameOps, address stakingRegistry, IERC20 feeToken, uint256 minFee, uint256 maxSponsoredWei) {
        FRAME_OPS = frameOps;
        STAKING_REGISTRY = stakingRegistry;
        FEE_TOKEN = feeToken;
        MIN_FEE = minFee;
        MAX_SPONSORED_WEI = maxSponsoredWei;
        FACTORY = new StealthBunkerFactory(address(this), frameOps);
    }

    receive() external payable {}

    /// @notice Stakes `msg.value` for this paymaster in the alt mempool's staking registry.
    function stake() external payable {
        IStakingRegistry(STAKING_REGISTRY).addStake{value: msg.value}(UNSTAKE_DELAY);
    }

    /// @notice The `pay` frame (VERIFY mode): verifies the spend and approves payment. Read-only.
    function approvePayment(SpendAuth calldata auth) external {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint(msg.sender);
        address sender = address(uint160(FRAME_OPS.txParam(TxParam.SENDER)));
        bytes32 commitment = StealthBunkerAccount(payable(sender)).COMMITMENT();
        if (FACTORY.addressOf(commitment) != sender) revert NotAStealthAccount(sender);
        if (StealthProfile.commitment(StealthProfile.spendKey(auth.threshold, auth.ids), auth.opener) != commitment) {
            revert Rejected(1);
        }

        TransferApproval.Data calldata a = auth.approval;
        if (a.token != address(FEE_TOKEN)) revert Rejected(17);
        if (auth.fee > a.maxFee) revert Rejected(3);
        if (auth.fee < MIN_FEE) revert Rejected(18);
        if (FRAME_OPS.txParam(TxParam.MAX_COST) > MAX_SPONSORED_WEI) revert Rejected(19);

        bytes32 digest = TransferApproval.digest(a, block.chainid, sender);
        (bytes32[] memory idHashes, uint256[] memory leaves) =
            Quorum.verify(auth.ids, auth.threshold, auth.signerIdx, auth.envelopes, digest);
        for (uint256 k = 0; k < leaves.length; k++) {
            if (_used[idHashes[k]][leaves[k]]) revert Rejected(4);
            if (StealthBunkerAccount(payable(sender)).isLeafUsedHere(idHashes[k], leaves[k])) revert Rejected(5);
        }
        // after the key checks, so a replay is refused for its used keys even once the account is empty
        if (FEE_TOKEN.balanceOf(sender) < a.amount + auth.fee) revert Rejected(20);

        uint256 i = FRAME_OPS.txParam(TxParam.CURRENT_FRAME_INDEX);
        if (FRAME_OPS.txParam(TxParam.FRAME_COUNT) != i + 5) revert Rejected(6);
        _expectFrame(i + 1, FrameMode.DEFAULT, address(this), false, abi.encodeCall(this.commit, (idHashes, leaves)));
        if (
            FRAME_OPS.frameParam(i + 1, FrameParam.EXECUTION_GAS_LIMIT) < COMMIT_MIN_EXECUTION_GAS
                || FRAME_OPS.frameParam(i + 1, FrameParam.STATE_GAS_LIMIT) < COMMIT_MIN_STATE_GAS
        ) revert Rejected(21);
        _expectFrame(i + 2, FrameMode.DEFAULT, address(this), true, abi.encodeCall(this.checkDeadline, (a.validUntil)));
        _expectFrame(i + 3, FrameMode.SENDER, a.token, true, abi.encodeCall(IERC20.transfer, (a.to, a.amount)));
        _expectFrame(
            i + 4, FrameMode.SENDER, a.token, false, abi.encodeCall(IERC20.transfer, (address(this), auth.fee))
        );

        FRAME_OPS.approve(Scope.PAYMENT);
    }

    /// @notice The frame right after `pay`: records the one-time keys that `pay` verified. It only runs when
    ///         the preceding frame is this paymaster's successful `approvePayment`, which in turn only
    ///         succeeds when this frame carries exactly those keys.
    function commit(bytes32[] calldata idHashes, uint256[] calldata leaves) external {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint(msg.sender);
        _requirePrevious(FrameMode.VERIFY, this.approvePayment.selector, 23);
        if (idHashes.length != leaves.length) revert Rejected(10);
        for (uint256 k = 0; k < leaves.length; k++) {
            if (_used[idHashes[k]][leaves[k]]) revert Rejected(11);
            _used[idHashes[k]][leaves[k]] = true;
        }
        emit KeysCommitted(address(uint160(FRAME_OPS.txParam(TxParam.SENDER))), leaves.length);
    }

    /// @notice Opens the atomic batch with the two transfers: they only run before the approval's deadline,
    ///         and right after a successful `commit`.
    function checkDeadline(uint64 validUntil) external {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint(msg.sender);
        _requirePrevious(FrameMode.DEFAULT, this.commit.selector, 24);
        if (block.timestamp > validUntil) revert Rejected(2);
    }

    /// @notice One-time keys this paymaster has recorded, shared by every stealth account.
    function isLeafUsed(bytes32 identityHash, uint256 leaf) external view returns (bool) {
        return _used[identityHash][leaf];
    }

    /// @dev The frame before this one must be a successful call of `selector` on this contract, in `mode`.
    function _requirePrevious(FrameMode mode, bytes4 selector, uint256 wrongCall) private view {
        uint256 i = FRAME_OPS.txParam(TxParam.CURRENT_FRAME_INDEX);
        if (i == 0) revert Rejected(7);
        uint256 p = i - 1;
        if (FRAME_OPS.frameTarget(p) != address(this)) revert Rejected(8);
        if (FRAME_OPS.frameParam(p, FrameParam.MODE) != uint256(mode)) revert Rejected(8);
        if (FRAME_OPS.frameParam(p, FrameParam.STATUS) != FRAME_SUCCESS) revert Rejected(9);
        if (FRAME_OPS.frameParam(p, FrameParam.DATA_LENGTH) < 4) revert Rejected(wrongCall);
        if (bytes4(FRAME_OPS.frameData(0, 4, p)) != selector) revert Rejected(wrongCall);
    }

    /// @dev Frame `index` must have this mode, target, atomic-batch flag and exactly this data, and no ETH value.
    function _expectFrame(uint256 index, FrameMode mode, address target, bool atomic, bytes memory data) private view {
        if (FRAME_OPS.frameParam(index, FrameParam.MODE) != uint256(mode)) revert Rejected(12);
        if (FRAME_OPS.frameTarget(index) != target) revert Rejected(13);
        bool hasAtomic = FRAME_OPS.frameParam(index, FrameParam.FLAGS) & ATOMIC_BATCH_FLAG != 0;
        if (hasAtomic != atomic) revert Rejected(14);
        if (FRAME_OPS.frameParam(index, FrameParam.VALUE) != 0) revert Rejected(22);
        if (FRAME_OPS.frameParam(index, FrameParam.DATA_LENGTH) != data.length) revert Rejected(15);
        if (keccak256(FRAME_OPS.frameData(0, data.length, index)) != keccak256(data)) revert Rejected(16);
    }
}
