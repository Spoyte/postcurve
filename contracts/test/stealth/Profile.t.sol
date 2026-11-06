// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StealthProfile} from "../../src/stealth/StealthProfile.sol";
import {TransferApproval} from "../../src/stealth/TransferApproval.sol";

/// Pins the Solidity profile and approval libraries to the TypeScript SDK via spec/vectors/stealth-v0.json.
contract ProfileTest is Test {
    string internal json;

    function setUp() public {
        json = vm.readFile("../spec/vectors/stealth-v0.json");
    }

    function ids() internal view returns (StealthProfile.Identity[] memory out) {
        out = new StealthProfile.Identity[](3);
        for (uint256 i = 0; i < 3; i++) {
            string memory p = string.concat(".identities[", vm.toString(i), "]");
            out[i] = StealthProfile.Identity(
                vm.parseJsonBytes32(json, string.concat(p, ".root")),
                vm.parseJsonBytes32(json, string.concat(p, ".pubSeed"))
            );
        }
    }

    function test_spendKey_matchesSdk() public view {
        uint256 threshold = vm.parseJsonUint(json, ".threshold");
        assertEq(StealthProfile.spendKey(threshold, ids()), vm.parseJsonBytes32(json, ".spendKey"));
    }

    function test_commitment_matchesSdk() public view {
        assertEq(
            StealthProfile.commitment(vm.parseJsonBytes32(json, ".spendKey"), vm.parseJsonBytes32(json, ".opener")),
            vm.parseJsonBytes32(json, ".commitment")
        );
    }

    function test_spendKey_dependsOnThresholdAndOrder() public view {
        StealthProfile.Identity[] memory a = ids();
        bytes32 base = StealthProfile.spendKey(2, a);
        assertTrue(StealthProfile.spendKey(3, a) != base);
        (a[0], a[1]) = (a[1], a[0]);
        assertTrue(StealthProfile.spendKey(2, a) != base);
    }

    function approval() internal view returns (TransferApproval.Data memory a) {
        a.nonce = vm.parseJsonUint(json, ".approval.nonce");
        a.token = vm.parseJsonAddress(json, ".approval.token");
        a.to = vm.parseJsonAddress(json, ".approval.to");
        a.amount = vm.parseJsonUint(json, ".approval.amount");
        a.maxFee = vm.parseJsonUint(json, ".approval.maxFee");
        a.validUntil = uint64(vm.parseJsonUint(json, ".approval.validUntil"));
    }

    function test_approvalDigest_matchesSdk() public view {
        uint256 chainId = vm.parseJsonUint(json, ".approval.chainId");
        address account = vm.parseJsonAddress(json, ".approval.account");
        assertEq(TransferApproval.digest(approval(), chainId, account), vm.parseJsonBytes32(json, ".approval.digest"));
    }

    function test_approvalDigest_dependsOnChainAndAccount() public view {
        uint256 chainId = vm.parseJsonUint(json, ".approval.chainId");
        address account = vm.parseJsonAddress(json, ".approval.account");
        bytes32 base = TransferApproval.digest(approval(), chainId, account);
        assertTrue(TransferApproval.digest(approval(), chainId + 1, account) != base);
        assertTrue(TransferApproval.digest(approval(), chainId, address(uint160(account) + 1)) != base);
    }
}
