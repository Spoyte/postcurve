// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestUSDC} from "../../src/stealth/TestUSDC.sol";
import {ERC5564Announcer} from "../../src/stealth/ERC5564Announcer.sol";

contract TokenTest is Test {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    TestUSDC token;
    ERC5564Announcer announcer;

    function setUp() public {
        token = new TestUSDC();
        announcer = new ERC5564Announcer();
    }

    function test_tokenIsLabelledAsATestTokenWithSixDecimals() public view {
        assertEq(token.decimals(), 6);
        assertEq(token.symbol(), "tUSDC");
        assertEq(token.name(), "Test USDC (postcurve local)");
    }

    function test_deployerCanMint() public {
        token.mint(address(0xb0b), 100e6);
        assertEq(token.balanceOf(address(0xb0b)), 100e6);
    }

    function test_othersCannotMint() public {
        vm.prank(address(0xbad));
        vm.expectRevert();
        token.mint(address(0xbad), 1);
    }

    function test_announceEmitsTheStandardEvent() public {
        bytes memory ct = hex"c1c2c3";
        bytes memory meta = hex"7a";
        vm.expectEmit(address(announcer));
        emit Announcement(2, address(0x5ea1), address(this), ct, meta);
        announcer.announce(2, address(0x5ea1), ct, meta);
    }
}
