// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {AcceptanceBase} from "./AcceptanceBase.sol";
import {INoteVault, IInsuranceFund} from "../src/interfaces/IDovizir.sol";
import {TranscriptLib} from "../src/TranscriptLib.sol";

/// INoteVault acceptance: cap-bounded carving, recipient-bound reconcile via
/// the frozen TranscriptLib encoding, double-spend conviction with
/// seizure-then-insurance compensation, expiry refunds (IDovizir.sol;
/// PROTOCOL.md §1). TranscriptLib IS the frozen transcript spec — arms must
/// verify exactly that encoding.
contract NoteVaultTest is AcceptanceBase {
    uint256 internal constant ISSUED = 100_000e6;
    uint64 internal constant TTL = 30 days;

    bytes32[] internal serials;
    bytes32 internal root;
    uint64 internal expiry;

    function setUp() public override {
        super.setUp();
        _certify(sarrafA);
        _addMember(sarrafA, memberA1);
        _issueBacked(sarrafA, memberA1, ISSUED);

        serials = _serials(4, "batch-0");
        root = TranscriptLib.computeRoot(serials);
        expiry = uint64(block.timestamp) + TTL;
    }

    function _carve(uint256 amount) internal {
        vm.prank(memberA1);
        vault.carve(root, amount, expiry);
    }

    /// Reconcile serials[idx] to `recipient` for `amount`, relayed by `relayer`.
    function _reconcile(uint256 idx, address recipient, uint256 amount, bytes32 invNonce) internal {
        (bytes memory transcript, bytes memory sig) =
            _spend(serials[idx], recipient, amount, invNonce, memberA1Pk);
        vm.prank(relayer);
        vault.reconcile(root, serials[idx], TranscriptLib.computeProof(serials, idx), transcript, sig);
    }

    // ------------------------------------------------------------------ carve

    /// IDovizir.sol: carve locks the member's sponsor-tranche IOUs against a
    /// serial-batch commitment; emits Carved; lockedOf tracks it; the locked
    /// value is no longer spendable from the member's balance.
    function test_carve_locksIou_recordsLockedOf_emitsCarved() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit INoteVault.Carved(memberA1, root, 30_000e6, expiry);
        _carve(30_000e6);

        assertEq(iou1155().balanceOf(memberA1, _id(sarrafA)), ISSUED - 30_000e6, "locked value leaves the member balance");
        assertEq(vault.lockedOf(memberA1), 30_000e6, "lockedOf tracks the carve");
    }

    /// Spec interpretation (README.md): the M1 base cap must be a usable
    /// nonzero limit — capOf(member) > 0 for an onboarded member, and at least
    /// 50k mock USDT for the fixtures of this suite.
    function test_capOf_isNonZeroForMember() public view {
        uint256 cap = vault.capOf(memberA1);
        assertGt(cap, 0, "base cap must be nonzero for a member");
        assertGe(cap, 50_000e6, "referee fixtures assume base cap >= 50k (see README.md)");
    }

    /// IDovizir.sol: "capOf(member) limits total locked value outstanding" —
    /// locking exactly the cap succeeds; one more unit reverts.
    function test_carve_totalLockedCappedAtCapOf() public {
        uint256 cap = vault.capOf(memberA1);
        require(cap <= 1e30, "capOf unreasonably large - spec review needed");
        _issueBacked(sarrafA, memberA1, cap + 1_000e6); // ensure balance beyond cap

        _carve(cap); // exactly at cap: allowed
        assertEq(vault.lockedOf(memberA1), cap);

        bytes32[] memory more = _serials(2, "batch-over");
        vm.prank(memberA1);
        vm.expectRevert();
        vault.carve(TranscriptLib.computeRoot(more), 1, uint64(block.timestamp) + TTL);

        assertEq(vault.lockedOf(memberA1), cap, "cap is a hard bound on locked outstanding");
    }

    /// The cap bounds locked value OUTSTANDING: value released by reconcile
    /// frees capacity for new carves.
    function test_carve_capacityFreedByReconcile() public {
        uint256 cap = vault.capOf(memberA1);
        require(cap <= 1e30, "capOf unreasonably large - spec review needed");
        _issueBacked(sarrafA, memberA1, cap + 2_000e6);

        _carve(cap);
        _reconcile(0, recipient1, 1_000e6, "inv-free");
        assertEq(vault.lockedOf(memberA1), cap - 1_000e6);

        bytes32[] memory next = _serials(2, "batch-next");
        vm.prank(memberA1);
        vault.carve(TranscriptLib.computeRoot(next), 1_000e6, uint64(block.timestamp) + TTL); // fits again

        assertEq(vault.lockedOf(memberA1), cap, "freed capacity is reusable");
    }

    // -------------------------------------------------------------- reconcile

    /// IDovizir.sol: first presentation of a valid recipient-bound transcript
    /// pays the invoice recipient in carver-tranche IOU, marks the serial
    /// spent, reduces the locked value, emits NoteReconciled.
    function test_reconcile_validTranscript_paysRecipient_marksSpent_emitsNoteReconciled() public {
        _carve(50_000e6);

        (bytes memory transcript, bytes memory sig) =
            _spend(serials[1], recipient1, 10_000e6, "inv-1", memberA1Pk);

        vm.expectEmit(true, true, true, true, address(vault));
        emit INoteVault.NoteReconciled(serials[1], recipient1, 10_000e6);
        vm.prank(relayer);
        vault.reconcile(root, serials[1], TranscriptLib.computeProof(serials, 1), transcript, sig);

        assertEq(iou1155().balanceOf(recipient1, _id(sarrafA)), 10_000e6, "recipient paid in carver tranche");
        assertTrue(vault.isSpent(serials[1]), "serial marked spent");
        assertFalse(vault.isSpent(serials[0]), "other serials untouched");
        assertEq(vault.lockedOf(memberA1), 40_000e6, "locked value reduced by the payment");
    }

    /// Courier mode: reconcile is relayable by ANYONE, and payment goes to
    /// the invoice-bound recipient — never to the relayer.
    function test_reconcile_relayableByAnyone_paysBoundRecipientOnly() public {
        _carve(50_000e6);
        (bytes memory transcript, bytes memory sig) =
            _spend(serials[0], recipient1, 5_000e6, "inv-relay", memberA1Pk);

        vm.prank(attacker); // hostile relayer changes nothing
        vault.reconcile(root, serials[0], TranscriptLib.computeProof(serials, 0), transcript, sig);

        assertEq(iou1155().balanceOf(recipient1, _id(sarrafA)), 5_000e6, "bound recipient paid");
        assertEq(iou1155().balanceOf(attacker, _id(sarrafA)), 0, "relayer gains nothing");
    }

    /// Recipient binding: a transcript whose invoice was tampered (recipient
    /// swapped after signing) no longer matches the carver signature — revert,
    /// nothing paid, serial not spent.
    function test_reconcile_tamperedRecipient_reverts() public {
        _carve(50_000e6);
        // Carver signed an invoice bound to recipient1...
        (, bytes memory sig) = _spend(serials[0], recipient1, 5_000e6, "inv-bind", memberA1Pk);
        // ...but the presented transcript names the attacker.
        bytes memory tampered = TranscriptLib.encodeTranscript(
            TranscriptLib.Invoice({recipient: attacker, amount: 5_000e6, nonce: "inv-bind"})
        );

        vm.prank(attacker);
        vm.expectRevert();
        vault.reconcile(root, serials[0], TranscriptLib.computeProof(serials, 0), tampered, sig);

        assertEq(iou1155().balanceOf(attacker, _id(sarrafA)), 0, "tampered transcript pays nobody");
        assertFalse(vault.isSpent(serials[0]), "serial not consumed");
        assertEq(vault.lockedOf(memberA1), 50_000e6);
    }

    /// Batch commitment: a serial outside the carved batch (bad merkle proof)
    /// reverts.
    function test_reconcile_serialNotInBatch_reverts() public {
        _carve(50_000e6);
        bytes32 foreign = keccak256("not-in-batch");
        (bytes memory transcript, bytes memory sig) =
            _spend(foreign, recipient1, 5_000e6, "inv-foreign", memberA1Pk);

        vm.prank(relayer);
        vm.expectRevert();
        vault.reconcile(root, foreign, TranscriptLib.computeProof(serials, 0), transcript, sig);

        assertFalse(vault.isSpent(foreign));
        assertEq(vault.lockedOf(memberA1), 50_000e6, "nothing paid for a foreign serial");
    }

    /// Carver binding: the transcript must be signed by the CARVER — any other
    /// signer reverts.
    function test_reconcile_nonCarverSignature_reverts() public {
        _carve(50_000e6);
        (bytes memory transcript, bytes memory sig) =
            _spend(serials[0], recipient1, 5_000e6, "inv-forge", attackerPk); // wrong key

        vm.prank(relayer);
        vm.expectRevert();
        vault.reconcile(root, serials[0], TranscriptLib.computeProof(serials, 0), transcript, sig);

        assertFalse(vault.isSpent(serials[0]));
        assertEq(vault.lockedOf(memberA1), 50_000e6);
    }

    /// First presentation must not overdraw the batch: an invoice amount above
    /// the remaining locked value reverts (issuance stays fully funded).
    function test_reconcile_amountAboveRemainingLocked_reverts() public {
        _carve(50_000e6);
        (bytes memory transcript, bytes memory sig) =
            _spend(serials[0], recipient1, 50_000e6 + 1, "inv-over", memberA1Pk);

        vm.prank(relayer);
        vm.expectRevert();
        vault.reconcile(root, serials[0], TranscriptLib.computeProof(serials, 0), transcript, sig);

        assertFalse(vault.isSpent(serials[0]));
        assertEq(iou1155().balanceOf(recipient1, _id(sarrafA)), 0);
    }

    /// PROTOCOL.md §1: a BYTE-IDENTICAL resubmission of an already-reconciled
    /// transcript is NOT a double-spend: it must never convict and never pay
    /// twice. Canonical behavior is revert("ALREADY_RECONCILED") — see
    /// README.md; a state-neutral no-op is tolerated, conviction is not.
    function test_reconcile_byteIdenticalResubmission_neverConvictsOrPaysTwice() public {
        _carve(50_000e6);
        (bytes memory transcript, bytes memory sig) =
            _spend(serials[2], recipient1, 10_000e6, "inv-dup", memberA1Pk);
        bytes32[] memory proof = TranscriptLib.computeProof(serials, 2);
        vm.prank(relayer);
        vault.reconcile(root, serials[2], proof, transcript, sig);

        uint256 paidBefore = iou1155().balanceOf(recipient1, _id(sarrafA));
        uint256 lockedBefore = vault.lockedOf(memberA1);
        uint256 reservesBefore = fund.totalReserves();

        vm.recordLogs();
        vm.prank(relayer);
        (bool ok,) = address(vault).call(
            abi.encodeCall(INoteVault.reconcile, (root, serials[2], proof, transcript, sig))
        );
        ok; // revert OR no-op both acceptable; conviction/double-pay are not

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(
                logs[i].topics[0] != INoteVault.DoubleSpendConvicted.selector,
                "byte-identical resubmission must NOT convict"
            );
            assertTrue(
                logs[i].topics[0] != INoteVault.NoteReconciled.selector,
                "byte-identical resubmission must NOT re-reconcile"
            );
        }
        assertEq(iou1155().balanceOf(recipient1, _id(sarrafA)), paidBefore, "no second payment");
        assertEq(vault.lockedOf(memberA1), lockedBefore, "no seizure");
        assertEq(fund.totalReserves(), reservesBefore, "no insurance claim");
        assertTrue(vault.isSpent(serials[2]), "serial stays spent");
    }

    /// PROTOCOL.md §1: a SECOND carver-signed transcript for the same serial
    /// with a DIFFERENT invoice is a double-spend. It convicts the carver
    /// (event names carver + later victim), seizes the carver's remaining
    /// locked value (all of it — lockedOf drops to zero), and the victim is
    /// made whole for the invoice amount without touching the InsuranceFund
    /// when seizure covers it.
    function test_reconcile_doubleSpend_convictsCarver_seizureCoversVictim() public {
        _carve(50_000e6);
        _reconcile(3, recipient1, 10_000e6, "inv-first"); // legitimate spend; 40k remains locked

        (bytes memory transcript2, bytes memory sig2) =
            _spend(serials[3], recipient2, 12_000e6, "inv-second", memberA1Pk); // same serial, new invoice
        uint256 victimIouBefore = iou1155().balanceOf(recipient2, _id(sarrafA));
        uint256 victimUsdtBefore = usdt.balanceOf(recipient2);
        uint256 reservesBefore = fund.totalReserves();

        vm.expectEmit(true, true, true, true, address(vault));
        emit INoteVault.DoubleSpendConvicted(serials[3], memberA1, recipient2);
        vm.prank(relayer);
        vault.reconcile(root, serials[3], TranscriptLib.computeProof(serials, 3), transcript2, sig2);

        uint256 victimGain = (iou1155().balanceOf(recipient2, _id(sarrafA)) - victimIouBefore)
            + (usdt.balanceOf(recipient2) - victimUsdtBefore);
        assertEq(victimGain, 12_000e6, "victim compensated exactly the invoice amount");
        assertEq(vault.lockedOf(memberA1), 0, "carver's remaining locked value fully seized");
        assertEq(fund.totalReserves(), reservesBefore, "seizure covered it: insurance untouched");
    }

    /// PROTOCOL.md §1: when the seized remainder is short of the victim's
    /// invoice, the InsuranceFund covers exactly the shortfall via payClaim
    /// (ClaimPaid names the victim, the shortfall, and the serial).
    function test_reconcile_doubleSpend_shortfallPaidByInsuranceFund_emitsClaimPaid() public {
        // Seed the fund with redemption fees: 1M redemption => 9_000e6 reserves.
        _addMember(sarrafA, memberA2);
        _issueBacked(sarrafA, memberA2, 1_000_000e6);
        vm.prank(memberA2);
        pool.redeem(sarrafA, 1_000_000e6);
        assertEq(fund.totalReserves(), 9_000e6, "fixture sanity");

        _carve(20_000e6);
        _reconcile(0, recipient1, 15_000e6, "inv-a"); // 5k remains locked

        // Double-spend of serials[0]: 12k invoice, only 5k seizable => 7k claim.
        (bytes memory transcript2, bytes memory sig2) =
            _spend(serials[0], recipient2, 12_000e6, "inv-b", memberA1Pk);
        uint256 victimIouBefore = iou1155().balanceOf(recipient2, _id(sarrafA));
        uint256 victimUsdtBefore = usdt.balanceOf(recipient2);

        vm.expectEmit(true, true, true, true, address(fund));
        emit IInsuranceFund.ClaimPaid(recipient2, 7_000e6, serials[0]);
        vm.prank(relayer);
        vault.reconcile(root, serials[0], TranscriptLib.computeProof(serials, 0), transcript2, sig2);

        uint256 victimGain = (iou1155().balanceOf(recipient2, _id(sarrafA)) - victimIouBefore)
            + (usdt.balanceOf(recipient2) - victimUsdtBefore);
        assertEq(victimGain, 12_000e6, "seizure + insurance make the victim whole");
        assertEq(fund.totalReserves(), 9_000e6 - 7_000e6, "fund pays exactly the shortfall");
        assertEq(vault.lockedOf(memberA1), 0, "seizure exhausted first");
    }

    /// A second presentation with a DIFFERENT invoice but WITHOUT a valid
    /// carver signature is not evidence of a double-spend: no conviction, no
    /// seizure, no claim.
    function test_reconcile_secondPresentationNotCarverSigned_doesNotConvict() public {
        _carve(50_000e6);
        _reconcile(1, recipient1, 10_000e6, "inv-x");

        (bytes memory transcript2, bytes memory sig2) =
            _spend(serials[1], recipient2, 12_000e6, "inv-y", attackerPk); // forged
        uint256 reservesBefore = fund.totalReserves();

        vm.recordLogs();
        vm.prank(attacker);
        (bool ok,) = address(vault).call(
            abi.encodeCall(
                INoteVault.reconcile,
                (root, serials[1], TranscriptLib.computeProof(serials, 1), transcript2, sig2)
            )
        );
        assertFalse(ok, "forged second presentation must revert");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(
                logs[i].topics[0] != INoteVault.DoubleSpendConvicted.selector,
                "no conviction without a carver-signed conflicting transcript"
            );
        }
        assertEq(vault.lockedOf(memberA1), 40_000e6, "no seizure");
        assertEq(fund.totalReserves(), reservesBefore, "no claim");
        assertEq(iou1155().balanceOf(recipient2, _id(sarrafA)), 0, "no payout");
    }

    /// Fuzz: a valid first presentation pays exactly the invoice amount and
    /// reduces lockedOf by exactly that amount, for any amount within the
    /// locked value.
    function testFuzz_reconcile_paysExactInvoiceAmount(uint256 amount, bytes32 invNonce) public {
        amount = bound(amount, 1, 50_000e6);
        _carve(50_000e6);

        _reconcile(2, recipient1, amount, invNonce);

        assertEq(iou1155().balanceOf(recipient1, _id(sarrafA)), amount);
        assertEq(vault.lockedOf(memberA1), 50_000e6 - amount);
        assertTrue(vault.isSpent(serials[2]));
    }

    // ------------------------------------------------------------------ refund

    /// IDovizir.sol: refundExpired only after expiry — before it, revert and
    /// keep the lock.
    function test_refundExpired_beforeExpiry_reverts() public {
        _carve(30_000e6);
        vm.warp(uint256(expiry) - 1); // still inside the note's life

        vm.prank(memberA1);
        vm.expectRevert();
        vault.refundExpired(root);

        assertEq(vault.lockedOf(memberA1), 30_000e6, "lock intact before expiry");
    }

    /// IDovizir.sol: after expiry, the UNSPENT locked value returns to the
    /// carver; spent serials stay spent; emits ExpiredRefunded.
    function test_refundExpired_afterExpiry_returnsUnspentValue_emitsExpiredRefunded() public {
        _carve(50_000e6);
        _reconcile(0, recipient1, 10_000e6, "inv-spent"); // 40k unspent
        uint256 balBefore = iou1155().balanceOf(memberA1, _id(sarrafA));

        vm.warp(uint256(expiry) + 1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit INoteVault.ExpiredRefunded(root, 40_000e6);
        vm.prank(memberA1);
        vault.refundExpired(root);

        assertEq(
            iou1155().balanceOf(memberA1, _id(sarrafA)), balBefore + 40_000e6, "unspent value refunded"
        );
        assertEq(vault.lockedOf(memberA1), 0, "nothing left locked");
        assertTrue(vault.isSpent(serials[0]), "spent serial remains spent after refund");
    }
}
