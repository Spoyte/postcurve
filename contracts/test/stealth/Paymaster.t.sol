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

contract PaymasterTest is FrameTestBase {
    address constant ENTRY_POINT = address(0xaa);
    uint256 constant FP_DATA_LENGTH = 4;
    PostcurvePaymaster pm;
    StealthBunkerAccount account;
    TokenForTests token;
    address recipient = address(0xbeef);
    bytes32 constant SIG_HASH = keccak256("frame tx sig hash");

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

    /// [only_verify(0, account), pre_verify(1, PM), pay(2, PM), sender(3, token), sender(4, token)]
    function layout(address to, uint256 amount, uint256 fee) internal {
        txp(TX_SENDER, uint256(uint160(address(account))));
        txp(TX_SIG_HASH, uint256(SIG_HASH));
        txp(TX_FRAME_COUNT, 5);
        frame(0, MODE_VERIFY, address(account));
        frame(1, MODE_DEFAULT, address(pm));
        frame(2, MODE_VERIFY, address(pm));
        frame(3, MODE_SENDER, address(token));
        frame(4, MODE_SENDER, address(token));
        setData(3, abi.encodeCall(IERC20.transfer, (to, amount)));
        setData(4, abi.encodeCall(IERC20.transfer, (address(pm), fee)));
    }

    function setData(uint256 index, bytes memory d) internal {
        frameData(index, d);
        MockFrameParam(ops.frameParamHelper()).put(index, FP_DATA_LENGTH, d.length);
    }

    function preVerify(PostcurvePaymaster.SpendAuth memory s) internal {
        txp(TX_CURRENT_FRAME_INDEX, 1);
        vm.prank(ENTRY_POINT);
        pm.preVerify(s);
    }

    /// Call before vm.expectRevert / vm.expectEmit: the mock call must not be "the next call".
    function atPayFrame() internal {
        txp(TX_CURRENT_FRAME_INDEX, 2);
    }

    function pay() internal {
        vm.prank(ENTRY_POINT);
        pm.approvePayment();
    }

    function expectPreVerifyRejected(PostcurvePaymaster.SpendAuth memory s) internal {
        txp(TX_CURRENT_FRAME_INDEX, 1);
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        pm.preVerify(s);
    }

    // ---------------------------------------------------------------- happy path

    function test_valid2of3_preVerifyThenPayApproves() public {
        layout(recipient, 24e6, 5e5);
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 1, 2, 5e5);
        txp(TX_CURRENT_FRAME_INDEX, 1);
        vm.prank(ENTRY_POINT);
        uint256 g = gasleft();
        pm.preVerify(s);
        console.log("gas, 2-of-3 preVerify:", g - gasleft());
        frameStatus(1, 1);
        atPayFrame();
        vm.expectEmit(address(pm));
        emit Approved(SCOPE_PAYMENT);
        pay();
        assertTrue(pm.isLeafUsed(StealthProfile.identityHash(s.ids[0]), 1));
        assertTrue(pm.isLeafUsed(StealthProfile.identityHash(s.ids[2]), 2));
    }

    // ---------------------------------------------------------------- quorum and keys

    function test_rejectsFewerThanThreshold() public {
        layout(recipient, 24e6, 5e5);
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 3, 4, 5e5);
        uint256[] memory one = new uint256[](1);
        bytes[] memory env = new bytes[](1);
        env[0] = s.envelopes[0];
        s.signerIdx = one;
        s.envelopes = env;
        expectPreVerifyRejected(s);
    }

    function test_rejectsTheSameSignerTwice() public {
        layout(recipient, 24e6, 5e5);
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 5, 6, 5e5);
        s.signerIdx[1] = 0;
        s.envelopes[1] = s.envelopes[0];
        expectPreVerifyRejected(s);
    }

    function test_rejectsALeafUsedInAnEarlierTx() public {
        layout(recipient, 24e6, 5e5);
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 7, 8, 5e5);
        preVerify(s);
        expectPreVerifyRejected(s);
    }

    function test_rejectsALeafSpentThroughTheEmergencyPath() public {
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
        e.envelopes[0] = sign(1, 9, digest);
        e.envelopes[1] = sign(3, 10, digest);
        vm.prank(ENTRY_POINT);
        account.emergencyExecute(e);
        // the same one-time keys, presented to the paymaster for that same approval
        layout(recipient, 1e6, 0);
        PostcurvePaymaster.SpendAuth memory s;
        s.threshold = 2;
        s.ids = e.ids;
        s.opener = e.opener;
        s.approval = a;
        s.signerIdx = e.signerIdx;
        s.envelopes = e.envelopes;
        s.fee = 0;
        expectPreVerifyRejected(s);
    }

    function test_rejectsAWrongOpener() public {
        layout(recipient, 24e6, 5e5);
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 11, 12, 5e5);
        s.opener = keccak256("another payment");
        expectPreVerifyRejected(s);
    }

    function test_rejectsIdentitiesForAnotherAccount() public {
        layout(recipient, 24e6, 5e5);
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 13, 14, 5e5);
        s.ids[1].root = keccak256("someone else");
        expectPreVerifyRejected(s);
    }

    function test_rejectsASenderThatIsNotAStealthAccount() public {
        layout(recipient, 24e6, 5e5);
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 15, 16, 5e5);
        txp(TX_SENDER, uint256(uint160(address(token))));
        expectPreVerifyRejected(s);
    }

    // ---------------------------------------------------------------- execution frames and fees

    function test_rejectsAFeeAboveMaxFee() public {
        layout(recipient, 24e6, 1e6 + 1);
        expectPreVerifyRejected(auth(approval(), 17, 18, 1e6 + 1));
    }

    function test_rejectsAnotherRecipientInTheTransferFrame() public {
        layout(address(0xbad), 24e6, 5e5);
        expectPreVerifyRejected(auth(approval(), 19, 20, 5e5));
    }

    function test_rejectsAnotherAmountInTheTransferFrame() public {
        layout(recipient, 25e6, 5e5);
        expectPreVerifyRejected(auth(approval(), 21, 22, 5e5));
    }

    function test_rejectsAFeeFrameThatDiffersFromTheAuth() public {
        layout(recipient, 24e6, 9e5);
        expectPreVerifyRejected(auth(approval(), 23, 24, 5e5));
    }

    function test_rejectsAnExpiredApproval() public {
        layout(recipient, 24e6, 5e5);
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 25, 26, 5e5);
        vm.warp(block.timestamp + 2 hours);
        expectPreVerifyRejected(s);
    }

    function test_rejectsPreVerifyFromOutsideTheEntryPoint() public {
        layout(recipient, 24e6, 5e5);
        PostcurvePaymaster.SpendAuth memory s = auth(approval(), 27, 28, 5e5);
        txp(TX_CURRENT_FRAME_INDEX, 1);
        vm.expectRevert();
        pm.preVerify(s);
    }

    // ---------------------------------------------------------------- pay

    function test_payRejectsWithoutASuccessfulPreVerify() public {
        layout(recipient, 24e6, 5e5);
        preVerify(auth(approval(), 29, 30, 5e5));
        frameStatus(1, 0);
        atPayFrame();
        vm.expectRevert();
        pay();
    }

    function test_payRejectsAStaleSigHash() public {
        layout(recipient, 24e6, 5e5);
        preVerify(auth(approval(), 31, 32, 5e5));
        frameStatus(1, 1);
        txp(TX_SIG_HASH, uint256(keccak256("another tx")));
        atPayFrame();
        vm.expectRevert();
        pay();
    }

    function test_payRejectsWhenThePrecedingFrameIsNotItsPreVerify() public {
        layout(recipient, 24e6, 5e5);
        preVerify(auth(approval(), 33, 34, 5e5));
        frameStatus(1, 1);
        frame(1, MODE_DEFAULT, address(0xbad));
        atPayFrame();
        vm.expectRevert();
        pay();
    }
}
