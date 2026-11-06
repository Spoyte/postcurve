// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {WotsXmss} from "../src/WotsXmss.sol";

/// Exposes the library with a real calldata envelope, as the bunker account will use it.
contract WotsXmssHarness {
    function verify(bytes32 root, bytes32 pubSeed, bytes32 digest, bytes calldata envelope)
        external
        pure
        returns (bool ok, uint256 leaf)
    {
        return WotsXmss.verify(WotsXmss.Identity(root, pubSeed), digest, envelope);
    }
}

contract WotsXmssTest is Test {
    WotsXmssHarness internal h;
    string internal json;

    struct V {
        bytes32 root;
        bytes32 pubSeed;
        bytes32 digest;
        uint256 leaf;
        bytes envelope;
    }

    function setUp() public {
        h = new WotsXmssHarness();
        json = vm.readFile("../spec/vectors/wots-xmss-v1.json");
    }

    function vec(uint256 i) internal view returns (V memory v) {
        string memory p = string.concat(".vectors[", vm.toString(i), "]");
        v.root = vm.parseJsonBytes32(json, string.concat(p, ".root"));
        v.pubSeed = vm.parseJsonBytes32(json, string.concat(p, ".pubSeed"));
        v.digest = vm.parseJsonBytes32(json, string.concat(p, ".digest"));
        v.leaf = vm.parseJsonUint(json, string.concat(p, ".leaf"));
        v.envelope = vm.parseJsonBytes(json, string.concat(p, ".envelope"));
    }

    function check(V memory v) internal view returns (bool ok, uint256 leaf) {
        return h.verify(v.root, v.pubSeed, v.digest, v.envelope);
    }

    function test_vectorA0_verifies() public view {
        (bool ok, uint256 leaf) = check(vec(0));
        assertTrue(ok);
        assertEq(leaf, 0);
    }

    function test_vectorA255_verifies() public view {
        (bool ok, uint256 leaf) = check(vec(1));
        assertTrue(ok);
        assertEq(leaf, 255);
    }

    function test_vectorB7_verifies() public view {
        (bool ok, uint256 leaf) = check(vec(2));
        assertTrue(ok);
        assertEq(leaf, 7);
    }

    function test_wrongDigest_fails() public view {
        V memory v = vec(0);
        v.digest = keccak256("something else");
        (bool ok,) = check(v);
        assertFalse(ok);
    }

    function test_wrongRoot_fails() public view {
        V memory v = vec(0);
        v.root = keccak256(abi.encode(v.root));
        (bool ok,) = check(v);
        assertFalse(ok);
    }

    function test_wrongPubSeed_fails() public view {
        V memory v = vec(0);
        v.pubSeed = keccak256(abi.encode(v.pubSeed));
        (bool ok,) = check(v);
        assertFalse(ok);
    }

    function test_flippedSigByte_fails() public view {
        V memory v = vec(1);
        v.envelope[32 + 5] = v.envelope[32 + 5] ^ 0x01;
        (bool ok,) = check(v);
        assertFalse(ok);
    }

    function test_flippedAuthByte_fails() public view {
        V memory v = vec(1);
        v.envelope[32 + 67 * 32 + 3] = v.envelope[32 + 67 * 32 + 3] ^ 0x80;
        (bool ok,) = check(v);
        assertFalse(ok);
    }

    function test_otherValidLeafIndex_fails() public view {
        V memory v = vec(2);
        _setLeafWord(v.envelope, 8);
        (bool ok,) = check(v);
        assertFalse(ok);
    }

    function test_leaf256_fails() public view {
        V memory v = vec(0);
        _setLeafWord(v.envelope, 256);
        (bool ok, uint256 leaf) = check(v);
        assertFalse(ok);
        assertEq(leaf, 0);
    }

    function test_shortEnvelope_fails() public view {
        V memory v = vec(0);
        bytes memory e = v.envelope;
        assembly {
            mstore(e, 2431)
        }
        (bool ok,) = check(v);
        assertFalse(ok);
    }

    function test_longEnvelope_fails() public view {
        V memory v = vec(0);
        v.envelope = bytes.concat(v.envelope, hex"00");
        (bool ok,) = check(v);
        assertFalse(ok);
    }

    function test_emptyEnvelope_fails() public view {
        V memory v = vec(0);
        v.envelope = "";
        (bool ok,) = check(v);
        assertFalse(ok);
    }

    function test_gas_oneApproval() public view {
        V memory a = vec(0);
        uint256 g = gasleft();
        (bool ok,) = check(a);
        uint256 used = g - gasleft();
        assertTrue(ok);
        console.log("gas, one approval:", used);
    }

    function test_gas_twoApprovals() public view {
        V memory a = vec(0);
        V memory b = vec(2);
        uint256 g = gasleft();
        (bool okA,) = check(a);
        (bool okB,) = check(b);
        uint256 used = g - gasleft();
        assertTrue(okA && okB);
        console.log("gas, two approvals:", used);
    }

    function _setLeafWord(bytes memory envelope, uint256 leaf) internal pure {
        assembly {
            mstore(add(envelope, 32), leaf)
        }
    }
}
