// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AcceptanceBase} from "./AcceptanceBase.sol";
import {IIouToken} from "../src/interfaces/IDovizir.sol";
import {AuthLib} from "../src/AuthLib.sol";

/// IIouToken acceptance: ERC-1155 issuer tranches + EIP-3009-style
/// transferWithAuthorization (IDovizir.sol; PROTOCOL.md §1).
contract IouTokenTest is AcceptanceBase {
    uint256 internal constant ISSUED = 1_000e6;

    function setUp() public override {
        super.setUp();
        _certify(sarrafA);
        _addMember(sarrafA, memberA1);
        _issueBacked(sarrafA, memberA1, ISSUED);
    }

    /// IDovizir.sol: one ERC-1155 id per sarraf, id = uint256(uint160(sarraf)).
    /// Issuance lands in the issuing sarraf's tranche and no other.
    function test_trancheIdIsSarrafAddress_issuanceLandsInIssuerTranche() public view {
        assertEq(iou1155().balanceOf(memberA1, _id(sarrafA)), ISSUED, "balance in issuer tranche");
        assertEq(iou1155().balanceOf(memberA1, _id(sarrafB)), 0, "no balance in foreign tranche");
    }

    /// IDovizir.sol: "Mint/burn are pool-only." Unprivileged callers (EOAs,
    /// even the tranche's own sarraf) must not mint.
    function test_mint_revertsForNonPoolCallers() public {
        uint256 id = _id(sarrafA);
        vm.prank(attacker);
        vm.expectRevert();
        iou.mint(attacker, id, 1e6);

        vm.prank(sarrafA); // not even the sarraf mints directly — only via pool.issue
        vm.expectRevert();
        iou.mint(sarrafA, id, 1e6);

        assertEq(iou1155().balanceOf(attacker, id), 0, "unauthorized mint must not credit");
        assertEq(iou1155().balanceOf(sarrafA, id), 0, "unauthorized mint must not credit");
    }

    /// IDovizir.sol: "Mint/burn are pool-only." Unprivileged callers must not burn.
    function test_burn_revertsForNonPoolCallers() public {
        uint256 id = _id(sarrafA);
        vm.prank(attacker);
        vm.expectRevert();
        iou.burn(memberA1, id, 1e6);

        vm.prank(sarrafA);
        vm.expectRevert();
        iou.burn(memberA1, id, 1e6);

        assertEq(iou1155().balanceOf(memberA1, id), ISSUED, "unauthorized burn must not debit");
    }

    /// IDovizir.sol transferWithAuthorization happy path: relayable by anyone
    /// (courier mode), EIP-712 signature per AuthLib (frozen domain), emits
    /// AuthorizationUsed, flips authorizationState, moves the tranche balance.
    function test_transferWithAuthorization_happyPath_emitsAndFlipsAuthorizationState() public {
        uint256 id = _id(sarrafA);
        uint256 amount = 250e6;
        bytes32 nonce = keccak256("auth-1");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 days;

        bytes memory sig = _sign(
            memberA1Pk,
            AuthLib.transferAuthDigest(
                address(iou), memberA1, recipient1, id, amount, validAfter, validBefore, nonce
            )
        );

        assertFalse(iou.authorizationState(memberA1, nonce), "nonce unused before");

        vm.expectEmit(true, true, true, true, address(iou));
        emit IIouToken.AuthorizationUsed(memberA1, nonce);
        vm.prank(relayer); // anyone may relay
        iou.transferWithAuthorization(memberA1, recipient1, id, amount, validAfter, validBefore, nonce, sig);

        assertEq(iou1155().balanceOf(recipient1, id), amount, "recipient credited");
        assertEq(iou1155().balanceOf(memberA1, id), ISSUED - amount, "signer debited");
        assertTrue(iou.authorizationState(memberA1, nonce), "authorizationState flips to used");
    }

    /// IDovizir.sol: "One-time nonce per `from`." Byte-identical replay
    /// reverts, and so does reusing the nonce with different parameters.
    function test_transferWithAuthorization_nonceReplay_reverts() public {
        uint256 id = _id(sarrafA);
        bytes32 nonce = keccak256("auth-replay");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 days;
        bytes memory sig = _sign(
            memberA1Pk,
            AuthLib.transferAuthDigest(address(iou), memberA1, recipient1, id, 100e6, validAfter, validBefore, nonce)
        );
        vm.prank(relayer);
        iou.transferWithAuthorization(memberA1, recipient1, id, 100e6, validAfter, validBefore, nonce, sig);

        // 1. byte-identical replay
        vm.prank(relayer);
        vm.expectRevert();
        iou.transferWithAuthorization(memberA1, recipient1, id, 100e6, validAfter, validBefore, nonce, sig);

        // 2. same nonce, different params, fresh valid signature
        bytes memory sig2 = _sign(
            memberA1Pk,
            AuthLib.transferAuthDigest(address(iou), memberA1, recipient2, id, 50e6, validAfter, validBefore, nonce)
        );
        vm.prank(relayer);
        vm.expectRevert();
        iou.transferWithAuthorization(memberA1, recipient2, id, 50e6, validAfter, validBefore, nonce, sig2);

        assertEq(iou1155().balanceOf(recipient1, id), 100e6, "only the first use may pay");
        assertEq(iou1155().balanceOf(recipient2, id), 0, "nonce reuse must not pay");
    }

    /// IDovizir.sol: authorization not yet valid (block.timestamp <= validAfter)
    /// reverts; the same authorization succeeds once time passes validAfter.
    function test_transferWithAuthorization_beforeValidAfter_reverts() public {
        uint256 id = _id(sarrafA);
        bytes32 nonce = keccak256("auth-early");
        uint256 validAfter = block.timestamp + 1 hours;
        uint256 validBefore = block.timestamp + 1 days;
        bytes memory sig = _sign(
            memberA1Pk,
            AuthLib.transferAuthDigest(address(iou), memberA1, recipient1, id, 10e6, validAfter, validBefore, nonce)
        );

        vm.prank(relayer);
        vm.expectRevert();
        iou.transferWithAuthorization(memberA1, recipient1, id, 10e6, validAfter, validBefore, nonce, sig);
        assertEq(iou1155().balanceOf(recipient1, id), 0, "early use must not pay");

        vm.warp(validAfter + 1);
        vm.prank(relayer);
        iou.transferWithAuthorization(memberA1, recipient1, id, 10e6, validAfter, validBefore, nonce, sig);
        assertEq(iou1155().balanceOf(recipient1, id), 10e6, "valid window pays");
    }

    /// IDovizir.sol: expired authorization (block.timestamp >= validBefore) reverts.
    function test_transferWithAuthorization_afterValidBefore_reverts() public {
        uint256 id = _id(sarrafA);
        bytes32 nonce = keccak256("auth-late");
        uint256 validAfter = block.timestamp - 2 days;
        uint256 validBefore = block.timestamp - 1;
        bytes memory sig = _sign(
            memberA1Pk,
            AuthLib.transferAuthDigest(address(iou), memberA1, recipient1, id, 10e6, validAfter, validBefore, nonce)
        );

        vm.prank(relayer);
        vm.expectRevert();
        iou.transferWithAuthorization(memberA1, recipient1, id, 10e6, validAfter, validBefore, nonce, sig);

        assertEq(iou1155().balanceOf(recipient1, id), 0, "expired authorization must not pay");
        assertFalse(iou.authorizationState(memberA1, nonce), "expired attempt must not consume nonce");
    }

    /// IDovizir.sol: the signature must recover to `from`. A signature by any
    /// other key over the same message reverts.
    function test_transferWithAuthorization_wrongSigner_reverts() public {
        uint256 id = _id(sarrafA);
        bytes32 nonce = keccak256("auth-forged");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 days;
        bytes memory forged = _sign(
            attackerPk,
            AuthLib.transferAuthDigest(address(iou), memberA1, attacker, id, ISSUED, validAfter, validBefore, nonce)
        );

        vm.prank(attacker);
        vm.expectRevert();
        iou.transferWithAuthorization(memberA1, attacker, id, ISSUED, validAfter, validBefore, nonce, forged);

        assertEq(iou1155().balanceOf(attacker, id), 0, "forged authorization must not pay");
        assertEq(iou1155().balanceOf(memberA1, id), ISSUED, "signer balance untouched");
        assertFalse(iou.authorizationState(memberA1, nonce), "forged attempt must not consume nonce");
    }

    /// Fuzz: any amount within the signer's balance transfers exactly.
    function testFuzz_transferWithAuthorization_transfersExactAmount(uint256 amount, bytes32 nonce) public {
        amount = bound(amount, 1, ISSUED);
        uint256 id = _id(sarrafA);
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 days;
        bytes memory sig = _sign(
            memberA1Pk,
            AuthLib.transferAuthDigest(address(iou), memberA1, recipient1, id, amount, validAfter, validBefore, nonce)
        );

        vm.prank(relayer);
        iou.transferWithAuthorization(memberA1, recipient1, id, amount, validAfter, validBefore, nonce, sig);

        assertEq(iou1155().balanceOf(recipient1, id), amount);
        assertEq(iou1155().balanceOf(memberA1, id), ISSUED - amount);
        assertTrue(iou.authorizationState(memberA1, nonce));
    }
}
