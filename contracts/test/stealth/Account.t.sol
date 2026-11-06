// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FrameTestBase} from "./FrameMocks.sol";
import {IFrameOps} from "../../src/stealth/FrameOps.sol";
import {StealthBunkerAccount, IPostcurvePaymaster} from "../../src/stealth/StealthBunkerAccount.sol";
import {StealthBunkerFactory} from "../../src/stealth/StealthBunkerFactory.sol";
import {StealthProfile} from "../../src/stealth/StealthProfile.sol";
import {TransferApproval} from "../../src/stealth/TransferApproval.sol";

contract TokenForTests is ERC20 {
    constructor() ERC20("Token for tests", "TT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract RegistryForTests is IPostcurvePaymaster {
    mapping(bytes32 => mapping(uint256 => bool)) public used;

    function mark(bytes32 idHash, uint256 leaf) external {
        used[idHash][leaf] = true;
    }

    function isLeafUsed(bytes32 idHash, uint256 leaf) external view returns (bool) {
        return used[idHash][leaf];
    }
}

contract AccountTest is FrameTestBase {
    address constant ENTRY_POINT = address(0xaa);
    RegistryForTests paymaster;
    StealthBunkerFactory factory;
    StealthBunkerAccount account;
    TokenForTests token;
    bytes32 commitment;
    address recipient = address(0xbeef);

    function setUp() public {
        setUpFrames();
        paymaster = new RegistryForTests();
        factory = new StealthBunkerFactory(address(paymaster), IFrameOps(address(ops)));
        commitment = StealthProfile.commitment(StealthProfile.spendKey(2, testIds()), testOpener());
        account = StealthBunkerAccount(payable(factory.deploy(commitment)));
        token = new TokenForTests();
        token.mint(address(account), 25e6);
    }

    // ---------------------------------------------------------------- factory

    function test_factory_deploysAtAddressOf() public view {
        assertEq(address(account), factory.addressOf(commitment));
        assertEq(account.COMMITMENT(), commitment);
        assertEq(account.PAYMASTER(), address(paymaster));
    }

    function test_factory_addressOf_followsTheCreate2Formula() public view {
        bytes memory init = abi.encodePacked(
            type(StealthBunkerAccount).creationCode, abi.encode(commitment, address(paymaster), address(ops))
        );
        address expected = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), bytes32(0), keccak256(init)))))
        );
        assertEq(factory.addressOf(commitment), expected);
    }

    function test_factory_deployIsIdempotent() public {
        assertEq(factory.deploy(commitment), address(account));
    }

    // ---------------------------------------------------------------- verifyExecution

    /// [only_verify(0), pre_verify(1, PM), pay(2, PM), sender(3, token), sender(4, token)]
    function goodShape() internal {
        txp(TX_CURRENT_FRAME_INDEX, 0);
        txp(TX_FRAME_COUNT, 5);
        frame(0, MODE_VERIFY, address(account));
        frame(1, MODE_DEFAULT, address(paymaster));
        frame(2, MODE_VERIFY, address(paymaster));
        frame(3, MODE_SENDER, address(token));
        frame(4, MODE_SENDER, address(token));
    }

    function test_verifyExecution_approvesTheExactShape() public {
        goodShape();
        vm.expectEmit(address(account));
        emit Approved(SCOPE_EXECUTION);
        vm.prank(ENTRY_POINT);
        account.verifyExecution();
    }

    function test_verifyExecution_approvesAfterADeployFrame() public {
        goodShape();
        txp(TX_CURRENT_FRAME_INDEX, 1);
        txp(TX_FRAME_COUNT, 6);
        frame(0, MODE_DEFAULT, address(factory));
        frame(1, MODE_VERIFY, address(account));
        frame(2, MODE_DEFAULT, address(paymaster));
        frame(3, MODE_VERIFY, address(paymaster));
        frame(4, MODE_SENDER, address(token));
        frame(5, MODE_SENDER, address(token));
        vm.expectEmit(address(account));
        emit Approved(SCOPE_EXECUTION);
        vm.prank(ENTRY_POINT);
        account.verifyExecution();
    }

    function expectRejected() internal {
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        account.verifyExecution();
    }

    function test_verifyExecution_rejectsAnotherPayer() public {
        goodShape();
        frame(2, MODE_VERIFY, address(0xbad));
        expectRejected();
    }

    function test_verifyExecution_rejectsAMissingPreVerify() public {
        goodShape();
        frame(1, MODE_VERIFY, address(paymaster));
        expectRejected();
    }

    function test_verifyExecution_rejectsAThirdSenderFrame() public {
        goodShape();
        txp(TX_FRAME_COUNT, 6);
        frame(5, MODE_SENDER, address(token));
        expectRejected();
    }

    function test_verifyExecution_rejectsTwoDifferentTokens() public {
        goodShape();
        frame(4, MODE_SENDER, address(0x70c));
        expectRejected();
    }

    function test_verifyExecution_rejectsADefaultModeTransfer() public {
        goodShape();
        frame(3, MODE_DEFAULT, address(token));
        expectRejected();
    }

    function test_verifyExecution_rejectsCallersOtherThanTheEntryPoint() public {
        goodShape();
        vm.expectRevert();
        account.verifyExecution();
    }

    // ---------------------------------------------------------------- emergencyExecute

    function emergencyAuth(uint256 leafA, uint256 leafB)
        internal
        returns (StealthBunkerAccount.EmergencyAuth memory auth)
    {
        auth.threshold = 2;
        auth.ids = testIds();
        auth.opener = testOpener();
        auth.approval = TransferApproval.Data({
            nonce: 0,
            token: address(token),
            to: recipient,
            amount: 25e6,
            maxFee: 0,
            validUntil: uint64(block.timestamp + 1 hours)
        });
        bytes32 digest = TransferApproval.digest(auth.approval, block.chainid, address(account));
        auth.signerIdx = new uint256[](2);
        auth.signerIdx[0] = 0;
        auth.signerIdx[1] = 1;
        auth.envelopes = new bytes[](2);
        auth.envelopes[0] = sign(1, leafA, digest);
        auth.envelopes[1] = sign(2, leafB, digest);
    }

    function test_emergency_validQuorumTransfers() public {
        StealthBunkerAccount.EmergencyAuth memory auth = emergencyAuth(3, 4);
        vm.prank(ENTRY_POINT);
        account.emergencyExecute(auth);
        assertEq(token.balanceOf(recipient), 25e6);
        assertTrue(account.isLeafUsedHere(StealthProfile.identityHash(auth.ids[0]), 3));
    }

    function test_emergency_rejectsAReplay() public {
        StealthBunkerAccount.EmergencyAuth memory auth = emergencyAuth(5, 6);
        token.mint(address(account), 25e6);
        vm.prank(ENTRY_POINT);
        account.emergencyExecute(auth);
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        account.emergencyExecute(auth);
    }

    function test_emergency_rejectsALeafThePaymasterRecorded() public {
        StealthBunkerAccount.EmergencyAuth memory auth = emergencyAuth(7, 8);
        paymaster.mark(StealthProfile.identityHash(auth.ids[1]), 8);
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        account.emergencyExecute(auth);
    }

    function test_emergency_rejectsAWrongOpener() public {
        StealthBunkerAccount.EmergencyAuth memory auth = emergencyAuth(9, 10);
        auth.opener = keccak256("another payment");
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        account.emergencyExecute(auth);
    }

    function test_emergency_rejectsOneOfThree() public {
        StealthBunkerAccount.EmergencyAuth memory auth = emergencyAuth(11, 12);
        uint256[] memory one = new uint256[](1);
        bytes[] memory env = new bytes[](1);
        env[0] = auth.envelopes[0];
        auth.signerIdx = one;
        auth.envelopes = env;
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        account.emergencyExecute(auth);
    }

    function test_emergency_rejectsTheSameSignerTwice() public {
        StealthBunkerAccount.EmergencyAuth memory auth = emergencyAuth(13, 14);
        auth.signerIdx[1] = 0;
        auth.envelopes[1] = auth.envelopes[0];
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        account.emergencyExecute(auth);
    }

    function test_emergency_rejectsANonZeroFee() public {
        StealthBunkerAccount.EmergencyAuth memory auth = emergencyAuth(15, 16);
        auth.approval.maxFee = 1;
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        account.emergencyExecute(auth);
    }

    function test_emergency_rejectsCallersOtherThanTheEntryPoint() public {
        StealthBunkerAccount.EmergencyAuth memory auth = emergencyAuth(17, 18);
        vm.expectRevert();
        account.emergencyExecute(auth);
    }
}
