// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FrameTestBase, MockFrameParam} from "./FrameMocks.sol";
import {TokenForTests} from "./Account.t.sol";
import {IFrameOps} from "../../src/stealth/FrameOps.sol";
import {PostcurvePaymaster} from "../../src/stealth/PostcurvePaymaster.sol";
import {StealthBunkerAccount} from "../../src/stealth/StealthBunkerAccount.sol";
import {StealthProfile} from "../../src/stealth/StealthProfile.sol";
import {TransferApproval} from "../../src/stealth/TransferApproval.sol";

/// Spend layout: [only_verify(0, account), pay(1, PM), commit(2, PM, atomic), transfer(3, token, atomic),
///                fee(4, token)]
contract PaymasterTest is FrameTestBase {
    address constant ENTRY_POINT = address(0xaa);
    uint256 constant PAY = 1;
    uint256 constant COMMIT = 2;
    PostcurvePaymaster pm;
    StealthBunkerAccount account;
    TokenForTests token;
    address recipient = address(0xbeef);

    function setUp() public {
        setUpFrames();
        pm = new PostcurvePaymaster(IFrameOps(address(ops)), address(0x5eed));
        bytes32 c = StealthProfile.commitment(StealthProfile.spendKey(2, testIds()), testOpener());
        account = StealthBunkerAccount(payable(pm.FACTORY().deploy(c)));
        token = new TokenForTests();
        token.mint(address(account), 25e6);
    }

    function approval() internal view returns (TransferApproval.Data memory) {
        return TransferApproval.Data({
            nonce: 0,
            token: address(token),
            to: recipient,
            amount: 24e6,
            maxFee: 1e6,
            validUntil: uint64(block.timestamp + 1 hours)
        });
    }

    /// Approvers 1 and 3 (ids[0], ids[2]) sign at leaves `leafA`, `leafB`.
    function auth(TransferApproval.Data memory a, uint256 leafA, uint256 leafB, uint256 fee)
        internal
        returns (PostcurvePaymaster.SpendAuth memory s)
    {
        s.threshold = 2;
        s.ids = testIds();
        s.opener = testOpener();
        s.approval = a;
        bytes32 digest = TransferApproval.digest(a, block.chainid, address(account));
        s.signerIdx = new uint256[](2);
        s.signerIdx[0] = 0;
        s.signerIdx[1] = 2;
        s.envelopes = new bytes[](2);
        s.envelopes[0] = sign(1, leafA, digest);
        s.envelopes[1] = sign(3, leafB, digest);
        s.fee = fee;
    }

    function keysOf(PostcurvePaymaster.SpendAuth memory s, uint256 leafA, uint256 leafB)
        internal
        pure
        returns (bytes32[] memory h, uint256[] memory l)
    {
        h = new bytes32[](2);
        l = new uint256[](2);
        h[0] = StealthProfile.identityHash(s.ids[0]);
        h[1] = StealthProfile.identityHash(s.ids[2]);
        l[0] = leafA;
        l[1] = leafB;
    }

    function layout(address to, uint256 amount, uint256 fee, bytes32[] memory h, uint256[] memory l) internal {
        layoutWithDeadline(to, amount, fee, h, l, uint64(block.timestamp + 1 hours));
    }

    function layoutWithDeadline(
        address to,
        uint256 amount,
        uint256 fee,
        bytes32[] memory h,
        uint256[] memory l,
        uint64 deadline
    ) internal {
        txp(TX_SENDER, uint256(uint160(address(account))));
        txp(TX_FRAME_COUNT, 5);
        frame(0, MODE_VERIFY, address(account));
        frame(PAY, MODE_VERIFY, address(pm));
        frame(COMMIT, MODE_DEFAULT, address(pm));
        frameFlags(COMMIT, FLAG_ATOMIC);
        setData(COMMIT, abi.encodeCall(PostcurvePaymaster.commit, (h, l, deadline)));
        frame(3, MODE_SENDER, address(token));
        frameFlags(3, FLAG_ATOMIC);
        setData(3, abi.encodeCall(IERC20.transfer, (to, amount)));
        frame(4, MODE_SENDER, address(token));
        setData(4, abi.encodeCall(IERC20.transfer, (address(pm), fee)));
    }

    /// A valid spend's layout for `s` signed at `leafA`, `leafB`.
    function goodLayout(PostcurvePaymaster.SpendAuth memory s, uint256 leafA, uint256 leafB) internal {
        (bytes32[] memory h, uint256[] memory l) = keysOf(s, leafA, leafB);
        layout(recipient, s.approval.amount, s.fee, h, l);
    }

    function setData(uint256 index, bytes memory d) internal {
        frameData(index, d);
        MockFrameParam(ops.frameParamHelper()).put(index, FP_DATA_LENGTH, d.length);
    }

    function atPay() internal {
        txp(TX_CURRENT_FRAME_INDEX, PAY);
    }

    function atCommit() internal {
        txp(TX_CURRENT_FRAME_INDEX, COMMIT);
    }

    function expectPayRejected(PostcurvePaymaster.SpendAuth memory s) internal {
        atPay();
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        pm.approvePayment(s);
    }

    /// pay, then commit, as the protocol would run them.
    function spend(PostcurvePaymaster.SpendAuth memory s, uint256 leafA, uint256 leafB) internal {
        atPay();
        vm.prank(ENTRY_POINT);
        pm.approvePayment(s);
        frameStatus(PAY, 1);
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = keysOf(s, leafA, leafB);
        vm.prank(ENTRY_POINT);
        pm.commit(h, l, s.approval.validUntil);
    }

    // ---------------------------------------------------------------- happy path

    function test_valid2of3_payApprovesThenCommitRecordsTheKeys() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 1, 2, 5e5);
        goodLayout(s, 1, 2);
        atPay();
        vm.expectEmit(address(pm));
        emit Approved(SCOPE_PAYMENT);
        vm.prank(ENTRY_POINT);
        uint256 g = gasleft();
        pm.approvePayment(s);
        console.log("gas, 2-of-3 approvePayment:", g - gasleft());
        frameStatus(PAY, 1);
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = keysOf(s, 1, 2);
        vm.prank(ENTRY_POINT);
        pm.commit(h, l, s.approval.validUntil);
        assertTrue(pm.isLeafUsed(h[0], 1));
        assertTrue(pm.isLeafUsed(h[1], 2));
    }

    function test_neverReadsTheClock() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 3, 4, 5e5);
        goodLayout(s, 3, 4);
        vm.warp(block.timestamp + 2 hours); // validation never reads the clock; commit enforces validUntil
        atPay();
        vm.prank(ENTRY_POINT);
        pm.approvePayment(s);
    }

    // ---------------------------------------------------------------- quorum and keys

    function test_rejectsFewerThanThreshold() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 5, 6, 5e5);
        goodLayout(s, 5, 6);
        uint256[] memory one = new uint256[](1);
        bytes[] memory env = new bytes[](1);
        env[0] = s.envelopes[0];
        s.signerIdx = one;
        s.envelopes = env;
        expectPayRejected(s);
    }

    function test_rejectsTheSameSignerTwice() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 7, 8, 5e5);
        goodLayout(s, 7, 8);
        s.signerIdx[1] = 0;
        s.envelopes[1] = s.envelopes[0];
        expectPayRejected(s);
    }

    function test_rejectsKeysCommittedInAnEarlierTx() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 9, 10, 5e5);
        goodLayout(s, 9, 10);
        spend(s, 9, 10);
        expectPayRejected(s);
    }

    function test_rejectsKeysSpentThroughTheEmergencyPath() public {
        TransferApproval.Data memory a = approval();
        a.maxFee = 0;
        a.amount = 1e6;
        StealthBunkerAccount.EmergencyAuth memory e;
        e.threshold = 2;
        e.ids = testIds();
        e.opener = testOpener();
        e.approval = a;
        bytes32 digest = TransferApproval.digest(a, block.chainid, address(account));
        e.signerIdx = new uint256[](2);
        e.signerIdx[0] = 0;
        e.signerIdx[1] = 2;
        e.envelopes = new bytes[](2);
        e.envelopes[0] = sign(1, 11, digest);
        e.envelopes[1] = sign(3, 12, digest);
        vm.prank(ENTRY_POINT);
        account.emergencyExecute(e);
        PostcurvePaymaster.SpendAuth memory s;
        s.threshold = 2;
        s.ids = e.ids;
        s.opener = e.opener;
        s.approval = a;
        s.signerIdx = e.signerIdx;
        s.envelopes = e.envelopes;
        s.fee = 0;
        goodLayout(s, 11, 12);
        expectPayRejected(s);
    }

    function test_rejectsAWrongOpener() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 13, 14, 5e5);
        goodLayout(s, 13, 14);
        s.opener = keccak256("another payment");
        expectPayRejected(s);
    }

    function test_rejectsIdentitiesForAnotherAccount() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 15, 16, 5e5);
        goodLayout(s, 15, 16);
        s.ids[1].root = keccak256("someone else");
        expectPayRejected(s);
    }

    function test_rejectsASenderThatIsNotAStealthAccount() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 17, 18, 5e5);
        goodLayout(s, 17, 18);
        txp(TX_SENDER, uint256(uint160(address(token))));
        expectPayRejected(s);
    }

    function test_rejectsPayFromOutsideTheEntryPoint() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 19, 20, 5e5);
        goodLayout(s, 19, 20);
        atPay();
        vm.expectRevert();
        pm.approvePayment(s);
    }

    // ---------------------------------------------------------------- execution frames and fees

    function test_rejectsAFeeAboveMaxFee() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 21, 22, 1e6 + 1);
        goodLayout(s, 21, 22);
        expectPayRejected(s);
    }

    function test_rejectsAnotherRecipientInTheTransferFrame() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 23, 24, 5e5);
        (bytes32[] memory h, uint256[] memory l) = keysOf(s, 23, 24);
        layout(address(0xbad), s.approval.amount, s.fee, h, l);
        expectPayRejected(s);
    }

    function test_rejectsAnotherAmountInTheTransferFrame() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 25, 26, 5e5);
        (bytes32[] memory h, uint256[] memory l) = keysOf(s, 25, 26);
        layout(recipient, s.approval.amount + 1, s.fee, h, l);
        expectPayRejected(s);
    }

    function test_rejectsAFeeFrameThatDiffersFromTheAuth() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 27, 28, 5e5);
        (bytes32[] memory h, uint256[] memory l) = keysOf(s, 27, 28);
        layout(recipient, s.approval.amount, 9e5, h, l);
        expectPayRejected(s);
    }

    function test_rejectsACommitFrameForOtherKeys() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 29, 30, 5e5);
        (bytes32[] memory h, uint256[] memory l) = keysOf(s, 29, 30);
        l[1] = 31;
        layout(recipient, s.approval.amount, s.fee, h, l);
        expectPayRejected(s);
    }

    function test_rejectsACommitFrameOutsideTheAtomicBatch() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 32, 33, 5e5);
        goodLayout(s, 32, 33);
        frameFlags(COMMIT, 0);
        expectPayRejected(s);
    }

    function test_rejectsATransferOutsideTheAtomicBatch() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 34, 35, 5e5);
        goodLayout(s, 34, 35);
        frameFlags(3, 0);
        expectPayRejected(s);
    }

    function test_rejectsAnExtraFrame() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 36, 37, 5e5);
        goodLayout(s, 36, 37);
        txp(TX_FRAME_COUNT, 6);
        expectPayRejected(s);
    }

    function test_rejectsACommitFrameWithAnotherDeadline() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 38, 39, 5e5);
        (bytes32[] memory h, uint256[] memory l) = keysOf(s, 38, 39);
        layoutWithDeadline(recipient, s.approval.amount, s.fee, h, l, s.approval.validUntil + 1);
        expectPayRejected(s);
    }

    function test_commitRejectsAnExpiredApproval() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 40, 41, 5e5);
        goodLayout(s, 40, 41);
        atPay();
        vm.prank(ENTRY_POINT);
        pm.approvePayment(s);
        frameStatus(PAY, 1);
        vm.warp(uint256(s.approval.validUntil) + 1);
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = keysOf(s, 40, 41);
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        pm.commit(h, l, s.approval.validUntil);
    }

    // ---------------------------------------------------------------- commit

    function commitKeys() internal pure returns (bytes32[] memory h, uint256[] memory l) {
        h = new bytes32[](1);
        l = new uint256[](1);
        h[0] = keccak256("victim identity");
        l[0] = 7;
    }

    function test_commitRejectsWithoutASuccessfulPayFrame() public {
        frame(PAY, MODE_VERIFY, address(pm));
        frameStatus(PAY, 0);
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = commitKeys();
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        pm.commit(h, l, uint64(block.timestamp + 1 hours));
    }

    function test_commitRejectsWhenThePayFrameIsAnotherPaymasters() public {
        frame(PAY, MODE_VERIFY, address(0xbad));
        frameStatus(PAY, 1);
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = commitKeys();
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        pm.commit(h, l, uint64(block.timestamp + 1 hours));
    }

    function test_commitRejectsCallersOtherThanTheEntryPoint() public {
        frame(PAY, MODE_VERIFY, address(pm));
        frameStatus(PAY, 1);
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = commitKeys();
        vm.expectRevert();
        pm.commit(h, l, uint64(block.timestamp + 1 hours));
    }

    function test_commitRejectsKeysAlreadyRecorded() public {
        frame(PAY, MODE_VERIFY, address(pm));
        frameStatus(PAY, 1);
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = commitKeys();
        vm.prank(ENTRY_POINT);
        pm.commit(h, l, uint64(block.timestamp + 1 hours));
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        pm.commit(h, l, uint64(block.timestamp + 1 hours));
    }
}
