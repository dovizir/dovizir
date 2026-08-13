// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArmBase} from "./ArmBase.sol";
import {TranscriptLib} from "dovizir-acceptance/TranscriptLib.sol";

/// Arm A unit tests for NoteVault beyond the referee suite: cross-batch
/// seizure via epochs, seizure-excess routing, expiry/refund edges, carve
/// guards.
contract NoteVaultArmTest is ArmBase {
    uint64 internal constant TTL = 30 days;

    bytes32[] internal serialsA;
    bytes32 internal rootA;
    bytes32[] internal serialsB;
    bytes32 internal rootB;
    uint64 internal expiry;

    function setUp() public override {
        super.setUp();
        _certify(sarrafA);
        _addMember(sarrafA, memberA1);
        _issueBacked(sarrafA, memberA1, 100_000e6);

        serialsA = _serials(3, "batch-A");
        rootA = TranscriptLib.computeRoot(serialsA);
        serialsB = _serials(3, "batch-B");
        rootB = TranscriptLib.computeRoot(serialsB);
        expiry = uint64(block.timestamp) + TTL;
    }

    function _carve(bytes32 root, uint256 amount) internal {
        vm.prank(memberA1);
        vault.carve(root, amount, expiry);
    }

    function _reconcile(
        bytes32 root,
        bytes32[] storage serials,
        uint256 idx,
        address recipient,
        uint256 amount,
        bytes32 nonce
    ) internal {
        (bytes memory transcript, bytes memory sig) = _spend(serials[idx], recipient, amount, nonce, memberA1Pk);
        vault.reconcile(root, serials[idx], TranscriptLib.computeProof(serials, idx), transcript, sig);
    }

    // ------------------------------------------------------------- carve edges

    function test_carve_duplicateRoot_reverts() public {
        _carve(rootA, 10_000e6);
        vm.prank(memberA1);
        vm.expectRevert(bytes("NoteVault: batch exists"));
        vault.carve(rootA, 5_000e6, expiry);
    }

    function test_carve_nonMember_reverts() public {
        vm.prank(outsider);
        vm.expectRevert(bytes("NoteVault: not a member"));
        vault.carve(rootA, 1e6, expiry);
    }

    function test_carve_pastExpiryOrZeroAmount_reverts() public {
        vm.prank(memberA1);
        vm.expectRevert(bytes("NoteVault: expiry in past"));
        vault.carve(rootA, 1e6, uint64(block.timestamp));

        vm.prank(memberA1);
        vm.expectRevert(bytes("NoteVault: zero amount"));
        vault.carve(rootA, 0, expiry);
    }

    function test_carve_escrowsIntoVaultCustody() public {
        _carve(rootA, 30_000e6);
        assertEq(iou.balanceOf(address(vault), _id(sarrafA)), 30_000e6, "vault holds the escrow");
        assertEq(vault.remainingOf(rootA), 30_000e6);
    }

    function test_capOf_nonMember_isZero() public view {
        assertEq(vault.capOf(outsider), 0);
    }

    // -------------------------------------------------------- reconcile edges

    function test_reconcile_afterExpiry_reverts() public {
        _carve(rootA, 10_000e6);
        vm.warp(uint256(expiry)); // notes valid iff now < expiry
        (bytes memory transcript, bytes memory sig) =
            _spend(serialsA[0], recipient1, 1_000e6, "late", memberA1Pk);
        vm.expectRevert(bytes("NoteVault: note expired"));
        vault.reconcile(rootA, serialsA[0], TranscriptLib.computeProof(serialsA, 0), transcript, sig);
    }

    function test_reconcile_unknownBatch_reverts() public {
        (bytes memory transcript, bytes memory sig) =
            _spend(serialsA[0], recipient1, 1_000e6, "nobatch", memberA1Pk);
        vm.expectRevert(bytes("NoteVault: unknown batch"));
        vault.reconcile(rootA, serialsA[0], TranscriptLib.computeProof(serialsA, 0), transcript, sig);
    }

    // -------------------------------------------------- double-spend seizures

    function test_conviction_seizesAcrossAllBatchesOfTheCarver() public {
        _carve(rootA, 20_000e6);
        _carve(rootB, 30_000e6);
        _reconcile(rootA, serialsA, 0, recipient1, 5_000e6, "first");
        assertEq(vault.lockedOf(memberA1), 45_000e6);

        // Conflicting spend of serialsA[0] convicts and seizes BOTH batches.
        (bytes memory t2, bytes memory s2) = _spend(serialsA[0], recipient2, 6_000e6, "second", memberA1Pk);
        vault.reconcile(rootA, serialsA[0], TranscriptLib.computeProof(serialsA, 0), t2, s2);

        assertEq(vault.lockedOf(memberA1), 0, "all locked value seized");
        assertEq(vault.remainingOf(rootA), 0, "convicted batch drained");
        assertEq(vault.remainingOf(rootB), 0, "sibling batch drained by the epoch bump");

        // The sibling batch can no longer pay out.
        (bytes memory t3, bytes memory s3) = _spend(serialsB[0], recipient1, 1e6, "afterwards", memberA1Pk);
        vm.expectRevert(bytes("NoteVault: exceeds locked value"));
        vault.reconcile(rootB, serialsB[0], TranscriptLib.computeProof(serialsB, 0), t3, s3);

        // ...and refunds nothing once expired.
        vm.warp(uint256(expiry) + 1);
        vm.expectRevert(bytes("NoteVault: nothing to refund"));
        vault.refundExpired(rootB);
    }

    function test_conviction_excessRoutedToFundWithFiftyFiftyBooks() public {
        _carve(rootA, 20_000e6);
        _reconcile(rootA, serialsA, 1, recipient1, 5_000e6, "first");

        (bytes memory t2, bytes memory s2) = _spend(serialsA[1], recipient2, 4_999e6, "second", memberA1Pk);
        vault.reconcile(rootA, serialsA[1], TranscriptLib.computeProof(serialsA, 1), t2, s2);

        // Seized 15_000e6; victim compensated 4_999e6; excess 10_001e6 to the fund.
        assertEq(iou.balanceOf(recipient2, _id(sarrafA)), 4_999e6);
        assertEq(iou.balanceOf(address(fund), _id(sarrafA)), 10_001e6, "excess IOU held by the fund");
        assertEq(
            fund.seizedIouOverseeingShare() + fund.seizedIouMaintenanceShare(),
            10_001e6,
            "seized books partition the excess"
        );
        assertEq(fund.seizedIouMaintenanceShare(), 10_001e6 / 2, "maintenance rounds down");
        assertEq(fund.totalReserves(), 0, "fee reserves untouched by seizure");
    }

    function test_conviction_withNothingLocked_victimFullyInsured() public {
        // Seed the fund.
        _addMember(sarrafA, memberA2);
        _issueBacked(sarrafA, memberA2, 1_000_000e6);
        vm.prank(memberA2);
        pool.redeem(sarrafA, 1_000_000e6); // reserves 9_000e6

        _carve(rootA, 10_000e6);
        _reconcile(rootA, serialsA, 0, recipient1, 10_000e6, "drain"); // locked -> 0

        (bytes memory t2, bytes memory s2) = _spend(serialsA[0], recipient2, 8_000e6, "conflict", memberA1Pk);
        vault.reconcile(rootA, serialsA[0], TranscriptLib.computeProof(serialsA, 0), t2, s2);

        assertEq(usdt.balanceOf(recipient2), 8_000e6, "victim paid fully from insurance");
        assertEq(iou.balanceOf(recipient2, _id(sarrafA)), 0, "no IOU available to seize");
        assertEq(fund.totalReserves(), 1_000e6);
    }

    function test_carveAfterSeizure_freshEpochWorksNormally() public {
        _carve(rootA, 10_000e6);
        _reconcile(rootA, serialsA, 0, recipient1, 1_000e6, "one");
        (bytes memory t2, bytes memory s2) = _spend(serialsA[0], recipient2, 500e6, "two", memberA1Pk);
        vault.reconcile(rootA, serialsA[0], TranscriptLib.computeProof(serialsA, 0), t2, s2); // conviction
        assertEq(vault.seizureEpochOf(memberA1), 1);

        // A new batch carved after the conviction is unaffected by it.
        _carve(rootB, 5_000e6);
        assertEq(vault.lockedOf(memberA1), 5_000e6);
        _reconcile(rootB, serialsB, 0, recipient1, 2_000e6, "fresh");
        assertEq(vault.remainingOf(rootB), 3_000e6, "post-seizure batch reconciles normally");
    }

    /// The convicted serial's evidence key survives: a THIRD conflicting
    /// presentation convicts again (idempotent seizure of zero) rather than
    /// paying out.
    function test_thirdConflictingPresentation_paysNothingMore() public {
        _carve(rootA, 10_000e6);
        _reconcile(rootA, serialsA, 0, recipient1, 1_000e6, "one");
        (bytes memory t2, bytes memory s2) = _spend(serialsA[0], recipient2, 500e6, "two", memberA1Pk);
        vault.reconcile(rootA, serialsA[0], TranscriptLib.computeProof(serialsA, 0), t2, s2);

        uint256 fundIouBefore = iou.balanceOf(address(fund), _id(sarrafA));
        (bytes memory t3, bytes memory s3) = _spend(serialsA[0], outsider, 700e6, "three", memberA1Pk);
        vm.expectRevert(); // nothing left to seize and no reserves: claim reverts
        vault.reconcile(rootA, serialsA[0], TranscriptLib.computeProof(serialsA, 0), t3, s3);
        assertEq(iou.balanceOf(address(fund), _id(sarrafA)), fundIouBefore, "no further value movement");
    }

    // ---------------------------------------------------------- refund edges

    function test_refund_secondCall_reverts() public {
        _carve(rootA, 10_000e6);
        vm.warp(uint256(expiry) + 1);
        vault.refundExpired(rootA);
        vm.expectRevert(bytes("NoteVault: already refunded"));
        vault.refundExpired(rootA);
    }

    function test_refund_payoutGoesToCarverEvenWhenTriggeredByOthers() public {
        _carve(rootA, 10_000e6);
        uint256 balBefore = iou.balanceOf(memberA1, _id(sarrafA));
        vm.warp(uint256(expiry) + 1);
        vm.prank(outsider); // anyone can trigger; value goes to the carver
        vault.refundExpired(rootA);
        assertEq(iou.balanceOf(memberA1, _id(sarrafA)), balBefore + 10_000e6);
        assertEq(iou.balanceOf(outsider, _id(sarrafA)), 0);
    }

    function test_refund_atExactExpiry_allowed_andReconcileComplementary() public {
        _carve(rootA, 10_000e6);
        vm.warp(uint256(expiry)); // now == expiry: note dead, refund live
        vault.refundExpired(rootA);
        assertEq(vault.lockedOf(memberA1), 0);
    }

    // ------------------------------------------------------------------ fuzz

    /// Custody solvency: after any single carve/reconcile/refund cycle the
    /// vault's escrow balance equals the aggregate lockedOf.
    function testFuzz_custodyMatchesLockedOf(uint256 carveAmt, uint256 spendAmt, bool refund) public {
        carveAmt = bound(carveAmt, 1, 100_000e6);
        spendAmt = bound(spendAmt, 1, carveAmt);
        _carve(rootA, carveAmt);
        _reconcile(rootA, serialsA, 0, recipient1, spendAmt, "fuzz");
        if (refund) {
            vm.warp(uint256(expiry) + 1);
            if (carveAmt > spendAmt) vault.refundExpired(rootA);
        }
        assertEq(
            iou.balanceOf(address(vault), _id(sarrafA)),
            vault.lockedOf(memberA1),
            "vault custody == locked bookkeeping"
        );
    }
}
