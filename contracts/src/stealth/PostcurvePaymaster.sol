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
/// @notice Pays the gas for a stealth bunker account's spend and takes its fee in the token being
///         spent, so the recipient never needs ETH from an address linked to them. As a staked entity
///         under ERC-8421 it has up to 1,000,000 validation gas, which carries the ~530k hash-only
///         quorum check the unstaked, freshly deployed account could not:
///
///         [deploy?] [only_verify: account] [pre_verify: this.preVerify] [pay: this] [sender: transfer] [sender: fee]
///
///         `preVerify` checks everything and records the one-time keys; `approvePayment` (the VERIFY
///         `pay` frame, which can't write storage) only checks that `preVerify` succeeded for this very
///         transaction.
///         If the paymaster doesn't approve payment, the transaction is invalid and nothing executes.
///         Immutable: no owner or admin. It deploys its own factory so each knows the other.
contract PostcurvePaymaster is IPostcurvePaymaster {
    using FrameOpsLib for IFrameOps;

    address public constant ENTRY_POINT = address(0xaa);
    uint256 internal constant FRAME_SUCCESS = 1;
    uint32 internal constant UNSTAKE_DELAY = 86400;

    IFrameOps public immutable FRAME_OPS;
    StealthBunkerFactory public immutable FACTORY;
    address public immutable STAKING_REGISTRY;

    mapping(bytes32 identityHash => mapping(uint256 leaf => bool)) private _used;
    /// @dev The sig_hash of the transaction `preVerify` last approved, per stealth account.
    mapping(address account => bytes32 sigHash) public pending;

    struct SpendAuth {
        uint256 threshold;
        StealthProfile.Identity[] ids;
        bytes32 opener;
        TransferApproval.Data approval;
        uint256[] signerIdx;
        bytes[] envelopes;
        uint256 fee;
    }

    event Sponsored(address indexed account, address indexed token, uint256 amount, uint256 fee);

    error NotEntryPoint(address caller);
    error NotAStealthAccount(address sender);
    error Rejected(uint256 reason);

    constructor(IFrameOps frameOps, address stakingRegistry) {
        FRAME_OPS = frameOps;
        STAKING_REGISTRY = stakingRegistry;
        FACTORY = new StealthBunkerFactory(address(this), frameOps);
    }

    receive() external payable {}

    /// @notice Stakes `msg.value` for this paymaster in the alt mempool's staking registry.
    function stake() external payable {
        IStakingRegistry(STAKING_REGISTRY).addStake{value: msg.value}(UNSTAKE_DELAY);
    }

    /// @notice The `pre_verify` frame (DEFAULT mode, immediately before this contract's `pay`).
    function preVerify(SpendAuth calldata auth) external {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint(msg.sender);
        address sender = address(uint160(FRAME_OPS.txParam(TxParam.SENDER)));
        bytes32 commitment = StealthBunkerAccount(payable(sender)).COMMITMENT();
        if (FACTORY.addressOf(commitment) != sender) revert NotAStealthAccount(sender);
        if (StealthProfile.commitment(StealthProfile.spendKey(auth.threshold, auth.ids), auth.opener) != commitment) {
            revert Rejected(1);
        }

        TransferApproval.Data calldata a = auth.approval;
        if (block.timestamp > a.validUntil) revert Rejected(2);
        if (auth.fee > a.maxFee) revert Rejected(3);

        uint256 i = FRAME_OPS.txParam(TxParam.CURRENT_FRAME_INDEX);
        _expectTransfer(i + 2, a.token, a.to, a.amount);
        _expectTransfer(i + 3, a.token, address(this), auth.fee);

        bytes32 digest = TransferApproval.digest(a, block.chainid, sender);
        (bytes32[] memory idHashes, uint256[] memory leaves) =
            Quorum.verify(auth.ids, auth.threshold, auth.signerIdx, auth.envelopes, digest);
        for (uint256 k = 0; k < leaves.length; k++) {
            if (_used[idHashes[k]][leaves[k]]) revert Rejected(4);
            if (StealthBunkerAccount(payable(sender)).isLeafUsedHere(idHashes[k], leaves[k])) revert Rejected(5);
            _used[idHashes[k]][leaves[k]] = true;
        }

        pending[sender] = bytes32(FRAME_OPS.txParam(TxParam.SIG_HASH));
        emit Sponsored(sender, a.token, a.amount, auth.fee);
    }

    /// @notice The `pay` frame (VERIFY mode, data = approvePayment()): approves payment only right after a
    ///         successful `preVerify` for this tx. A named function, not the fallback: empty calldata
    ///         would reach `receive()` instead.
    function approvePayment() external {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint(msg.sender);
        uint256 i = FRAME_OPS.txParam(TxParam.CURRENT_FRAME_INDEX);
        if (i == 0) revert Rejected(6);
        if (FRAME_OPS.frameTarget(i - 1) != address(this)) revert Rejected(7);
        if (FRAME_OPS.frameParam(i - 1, FrameParam.MODE) != uint256(FrameMode.DEFAULT)) revert Rejected(7);
        if (FRAME_OPS.frameParam(i - 1, FrameParam.STATUS) != FRAME_SUCCESS) revert Rejected(8);
        address sender = address(uint160(FRAME_OPS.txParam(TxParam.SENDER)));
        if (pending[sender] != bytes32(FRAME_OPS.txParam(TxParam.SIG_HASH))) revert Rejected(9);
        FRAME_OPS.approve(Scope.PAYMENT);
    }

    /// @notice One-time keys this paymaster has accepted, shared by every stealth account.
    function isLeafUsed(bytes32 identityHash, uint256 leaf) external view returns (bool) {
        return _used[identityHash][leaf];
    }

    /// @dev Frame `index` must be a SENDER frame calling `token.transfer(to, amount)`, exactly.
    function _expectTransfer(uint256 index, address token, address to, uint256 amount) private view {
        if (FRAME_OPS.frameParam(index, FrameParam.MODE) != uint256(FrameMode.SENDER)) revert Rejected(10);
        if (FRAME_OPS.frameTarget(index) != token) revert Rejected(11);
        bytes memory expected = abi.encodeCall(IERC20.transfer, (to, amount));
        if (FRAME_OPS.frameParam(index, FrameParam.DATA_LENGTH) != expected.length) revert Rejected(12);
        if (keccak256(FRAME_OPS.frameData(0, expected.length, index)) != keccak256(expected)) revert Rejected(13);
    }
}
