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

/// Spend layout: [only_verify(0, account), pay(1, PM), commit(2, PM), checkDeadline(3, PM, atomic),
///                transfer(4, token, atomic), fee(5, token)]; the atomic batch is frames 3..5.
contract PaymasterTest is FrameTestBase {
    address constant ENTRY_POINT = address(0xaa);
    uint256 constant PAY = 1;
    uint256 constant COMMIT = 2;
    uint256 constant DEADLINE = 3;
    uint256 constant TRANSFER = 4;
    uint256 constant FEE = 5;
    uint256 constant MIN_FEE = 5e5;
    uint256 constant MAX_SPONSORED_WEI = 0.01 ether;
    PostcurvePaymaster pm;
    StealthBunkerAccount account;
    TokenForTests token;
    address layoutToken;
    address recipient = address(0xbeef);

    function setUp() public {
        setUpFrames();
        token = new TokenForTests();
        pm = new PostcurvePaymaster(
            IFrameOps(address(ops)), address(0x5eed), IERC20(address(token)), MIN_FEE, MAX_SPONSORED_WEI
        );
        bytes32 c = StealthProfile.commitment(StealthProfile.spendKey(2, testIds()), testOpener());
        account = StealthBunkerAccount(payable(pm.FACTORY().deploy(c)));
        token.mint(address(account), 25e6);
        layoutToken = address(token);
    }

    function approval() internal view returns (TransferApproval.Data memory) {
        return TransferApproval.Data({
            nonce: 0,
            token: layoutToken,
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
        txp(TX_FRAME_COUNT, 6);
        txp(TX_MAX_COST, 0.005 ether);
        frame(0, MODE_VERIFY, address(account));
        frame(PAY, MODE_VERIFY, address(pm));
        setData(PAY, abi.encodePacked(PostcurvePaymaster.approvePayment.selector));
        frame(COMMIT, MODE_DEFAULT, address(pm));
        setData(COMMIT, abi.encodeCall(PostcurvePaymaster.commit, (h, l)));
        frameParamSet(COMMIT, FP_EXECUTION_GAS_LIMIT, 120_000);
        frameParamSet(COMMIT, FP_STATE_GAS_LIMIT, 300_000);
        frame(DEADLINE, MODE_DEFAULT, address(pm));
        frameFlags(DEADLINE, FLAG_ATOMIC);
        setData(DEADLINE, abi.encodeCall(PostcurvePaymaster.checkDeadline, (deadline)));
        frame(TRANSFER, MODE_SENDER, layoutToken);
        frameFlags(TRANSFER, FLAG_ATOMIC);
        setData(TRANSFER, abi.encodeCall(IERC20.transfer, (to, amount)));
        frame(FEE, MODE_SENDER, layoutToken);
        setData(FEE, abi.encodeCall(IERC20.transfer, (address(pm), fee)));
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

    function atDeadline() internal {
        txp(TX_CURRENT_FRAME_INDEX, DEADLINE);
    }

    function expectPayRejected(PostcurvePaymaster.SpendAuth memory s) internal {
        atPay();
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        pm.approvePayment(s);
    }

    function expectPayRejectedWith(PostcurvePaymaster.SpendAuth memory s, uint256 reason) internal {
        atPay();
        vm.prank(ENTRY_POINT);
        vm.expectRevert(abi.encodeWithSelector(PostcurvePaymaster.Rejected.selector, reason));
        pm.approvePayment(s);
    }

    function expectRejectedWith(uint256 reason) internal {
        vm.expectRevert(abi.encodeWithSelector(PostcurvePaymaster.Rejected.selector, reason));
    }

    /// pay, then commit, then the deadline check, as the protocol would run them.
    function spend(PostcurvePaymaster.SpendAuth memory s, uint256 leafA, uint256 leafB) internal {
        atPay();
        vm.prank(ENTRY_POINT);
        pm.approvePayment(s);
        frameStatus(PAY, 1);
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = keysOf(s, leafA, leafB);
        vm.prank(ENTRY_POINT);
        pm.commit(h, l);
        frameStatus(COMMIT, 1);
        atDeadline();
        vm.prank(ENTRY_POINT);
        pm.checkDeadline(s.approval.validUntil);
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
        pm.commit(h, l);
        assertTrue(pm.isLeafUsed(h[0], 1));
        assertTrue(pm.isLeafUsed(h[1], 2));
        frameStatus(COMMIT, 1);
        atDeadline();
        vm.prank(ENTRY_POINT);
        pm.checkDeadline(s.approval.validUntil);
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

    /// A replay after the account was emptied is refused for its used keys, so the reason shown is the true one.
    function test_aReplayIsRefusedForItsUsedKeysEvenWhenTheAccountIsEmpty() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 58, 59, 5e5);
        goodLayout(s, 58, 59);
        spend(s, 58, 59);
        vm.prank(address(account));
        IERC20(address(token)).transfer(recipient, 25e6);
        expectPayRejectedWith(s, 4);
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
        TransferApproval.Data memory b = approval();
        b.amount = 23e6; // the emergency spend moved 1 of the 25 held
        PostcurvePaymaster.SpendAuth memory s = auth(b, 11, 12, 5e5);
        goodLayout(s, 11, 12);
        expectPayRejectedWith(s, 5);
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

    function test_rejectsACommitFrameInsideTheAtomicBatch() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 32, 33, 5e5);
        goodLayout(s, 32, 33);
        frameFlags(COMMIT, FLAG_ATOMIC);
        expectPayRejected(s);
    }

    function test_rejectsADeadlineCheckOutsideTheAtomicBatch() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 42, 43, 5e5);
        goodLayout(s, 42, 43);
        frameFlags(DEADLINE, 0);
        expectPayRejected(s);
    }

    function test_rejectsATransferOutsideTheAtomicBatch() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 34, 35, 5e5);
        goodLayout(s, 34, 35);
        frameFlags(TRANSFER, 0);
        expectPayRejected(s);
    }

    function test_rejectsAnExtraFrame() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 36, 37, 5e5);
        goodLayout(s, 36, 37);
        txp(TX_FRAME_COUNT, 7);
        expectPayRejected(s);
    }

    function test_rejectsADeadlineCheckWithAnotherDeadline() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 38, 39, 5e5);
        (bytes32[] memory h, uint256[] memory l) = keysOf(s, 38, 39);
        layoutWithDeadline(recipient, s.approval.amount, s.fee, h, l, s.approval.validUntil + 1);
        expectPayRejected(s);
    }

    /// Review finding 3: an expired approval must cost the paymaster one transaction, not one per replay.
    function test_anExpiredApprovalBurnsTheKeysAndStopsTheTransfers() public {
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
        pm.commit(h, l);
        frameStatus(COMMIT, 1);
        atDeadline();
        vm.prank(ENTRY_POINT);
        expectRejectedWith(2);
        pm.checkDeadline(s.approval.validUntil);
        assertTrue(pm.isLeafUsed(h[0], 40));
        assertTrue(pm.isLeafUsed(h[1], 41));
        expectPayRejected(s);
    }

    // ---------------------------------------------------------------- what the paymaster agrees to pay

    /// Review finding 2: only the fee token, at least the minimum fee, a capped ETH cost, no ETH value.
    function test_rejectsASpendOfAnotherToken() public {
        TokenForTests other = new TokenForTests();
        other.mint(address(account), 25e6);
        layoutToken = address(other);
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 44, 45, 5e5);
        goodLayout(s, 44, 45);
        expectPayRejectedWith(s, 17);
    }

    function test_rejectsAFeeBelowTheMinimum() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 46, 47, MIN_FEE - 1);
        goodLayout(s, 46, 47);
        expectPayRejectedWith(s, 18);
    }

    function test_rejectsATxThatMayCostMoreThanTheCap() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 48, 49, 5e5);
        goodLayout(s, 48, 49);
        txp(TX_MAX_COST, MAX_SPONSORED_WEI + 1);
        expectPayRejectedWith(s, 19);
    }

    function test_rejectsAFrameThatCarriesEth() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 50, 51, 5e5);
        goodLayout(s, 50, 51);
        frameParamSet(TRANSFER, FP_VALUE, 1);
        expectPayRejectedWith(s, 22);
    }

    function test_rejectsACommitFrameWithTooLittleExecutionGas() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 52, 53, 5e5);
        goodLayout(s, 52, 53);
        frameParamSet(COMMIT, FP_EXECUTION_GAS_LIMIT, 1);
        expectPayRejectedWith(s, 21);
    }

    function test_rejectsACommitFrameWithTooLittleStateGas() public {
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 54, 55, 5e5);
        goodLayout(s, 54, 55);
        frameParamSet(COMMIT, FP_STATE_GAS_LIMIT, 1);
        expectPayRejectedWith(s, 21);
    }

    /// Review finding 3: a spend the account can't cover would unroll after the paymaster paid.
    function test_rejectsWhenTheAccountCannotCoverAmountAndFee() public {
        TransferApproval.Data memory a = approval();
        a.amount = 25e6 - 4e5; // + 0.5 fee > 25 held
        PostcurvePaymaster.SpendAuth memory s = auth(a, 56, 57, 5e5);
        goodLayout(s, 56, 57);
        expectPayRejectedWith(s, 20);
    }

    // ---------------------------------------------------------------- commit

    function commitKeys() internal pure returns (bytes32[] memory h, uint256[] memory l) {
        h = new bytes32[](1);
        l = new uint256[](1);
        h[0] = keccak256("victim identity");
        l[0] = 7;
    }

    function payFrame(uint256 status, bytes memory data) internal {
        frame(PAY, MODE_VERIFY, address(pm));
        frameStatus(PAY, status);
        setData(PAY, data);
    }

    function approvePaymentCall() internal pure returns (bytes memory) {
        return abi.encodePacked(PostcurvePaymaster.approvePayment.selector);
    }

    function test_commitRejectsWithoutASuccessfulPayFrame() public {
        payFrame(0, approvePaymentCall());
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = commitKeys();
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        pm.commit(h, l);
    }

    function test_commitRejectsWhenThePayFrameIsAnotherPaymasters() public {
        frame(PAY, MODE_VERIFY, address(0xbad));
        frameStatus(PAY, 1);
        setData(PAY, approvePaymentCall());
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = commitKeys();
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        pm.commit(h, l);
    }

    /// Review finding 1: a successful VERIFY frame to this paymaster that isn't `approvePayment` (any view
    /// function succeeds there) must not let `commit` record someone else's keys.
    function test_commitRejectsAfterAPaymasterViewCallInVerifyMode() public {
        payFrame(1, abi.encodeCall(PostcurvePaymaster.isLeafUsed, (bytes32(0), 0)));
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = commitKeys();
        vm.prank(ENTRY_POINT);
        expectRejectedWith(23);
        pm.commit(h, l);
        assertFalse(pm.isLeafUsed(h[0], l[0]));
    }

    function test_commitRejectsAfterAPayFrameWithNoData() public {
        payFrame(1, "");
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = commitKeys();
        vm.prank(ENTRY_POINT);
        expectRejectedWith(23);
        pm.commit(h, l);
    }

    function test_commitRejectsCallersOtherThanTheEntryPoint() public {
        payFrame(1, approvePaymentCall());
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = commitKeys();
        vm.expectRevert();
        pm.commit(h, l);
    }

    function test_commitRejectsKeysAlreadyRecorded() public {
        payFrame(1, approvePaymentCall());
        atCommit();
        (bytes32[] memory h, uint256[] memory l) = commitKeys();
        vm.prank(ENTRY_POINT);
        pm.commit(h, l);
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        pm.commit(h, l);
    }

    // ---------------------------------------------------------------- checkDeadline

    function commitFrame(uint256 status, bytes memory data) internal {
        frame(COMMIT, MODE_DEFAULT, address(pm));
        frameStatus(COMMIT, status);
        setData(COMMIT, data);
    }

    function commitCall() internal pure returns (bytes memory) {
        (bytes32[] memory h, uint256[] memory l) = commitKeys();
        return abi.encodeCall(PostcurvePaymaster.commit, (h, l));
    }

    function test_checkDeadlinePassesAfterASuccessfulCommit() public {
        commitFrame(1, commitCall());
        atDeadline();
        vm.prank(ENTRY_POINT);
        pm.checkDeadline(uint64(block.timestamp));
    }

    function test_checkDeadlineRejectsWhenTheCommitFailed() public {
        commitFrame(0, commitCall());
        atDeadline();
        vm.prank(ENTRY_POINT);
        expectRejectedWith(9);
        pm.checkDeadline(uint64(block.timestamp + 1 hours));
    }

    function test_checkDeadlineRejectsAfterAnotherCall() public {
        commitFrame(1, abi.encodeCall(PostcurvePaymaster.isLeafUsed, (bytes32(0), 0)));
        atDeadline();
        vm.prank(ENTRY_POINT);
        expectRejectedWith(24);
        pm.checkDeadline(uint64(block.timestamp + 1 hours));
    }

    function test_checkDeadlineRejectsCallersOtherThanTheEntryPoint() public {
        commitFrame(1, commitCall());
        atDeadline();
        vm.expectRevert();
        pm.checkDeadline(uint64(block.timestamp + 1 hours));
    }
}
