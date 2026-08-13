// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AcceptanceBase} from "./AcceptanceBase.sol";
import {INoteVault} from "../src/interfaces/IDovizir.sol";
import {TranscriptLib} from "../src/TranscriptLib.sol";

/// Regression suite encoding the PoC-verified CRITICAL from the M1 adversarial
/// review (docs/experiment/REVIEW-FINDINGS-M1.md): the InsuranceFund was fully
/// drainable via an unbounded, replayable double-spend conviction. The exploit:
/// a malicious carver self-colludes with an attacker recipient, does one legit
/// first spend, then submits a large carver-signed "conviction" transcript for
/// the same serial and REPLAYS it — once the carver's locked value is exhausted
/// every replay becomes a pure payClaim(attacker, carverChosenAmount) capped
/// only by fund reserves.
///
/// After the fixes this must fail to exploit:
///   #1 compensation is bounded by the serial's ORIGINAL first-spend amount;
///   #2 a serial is convicted at most once (replays revert ALREADY_CONVICTED);
///   #3 CEI + reentrancy guard on reconcile.
contract NoteVaultSecurityTest is AcceptanceBase {
    bytes32[] internal serials;
    bytes32 internal root;
    uint64 internal expiry;

    function setUp() public override {
        super.setUp();
        _certify(sarrafA);
        _addMember(sarrafA, memberA1);
        // Seed the fund with real reserves the exploit would drain: a 1M
        // redemption yields 9_000e6 of 90bps fee reserves.
        _addMember(sarrafA, memberA2);
        _issueBacked(sarrafA, memberA2, 1_000_000e6);
        vm.prank(memberA2);
        pool.redeem(sarrafA, 1_000_000e6);
        assertEq(fund.totalReserves(), 9_000e6, "fixture: fund seeded");

        _issueBacked(sarrafA, memberA1, 100_000e6);
        serials = _serials(4, "sec-batch");
        root = TranscriptLib.computeRoot(serials);
        expiry = uint64(block.timestamp) + 30 days;
        vm.prank(memberA1);
        vault.carve(root, 20_000e6, expiry);
    }

    /// The fund-drain PoC: bounded payout + anti-replay defeat it.
    function test_regression_replayedConvictionCannotDrainFund() public {
        // Legit first spend: the note is worth 2_000e6 (recorded as its ceiling).
        (bytes memory t1, bytes memory s1) =
            _spend(serials[0], recipient1, 2_000e6, "legit", memberA1Pk, root, expiry);
        vm.prank(relayer);
        vault.reconcile(root, serials[0], TranscriptLib.computeProof(serials, 0), t1, s1);

        // Malicious conviction transcript: same serial, a huge carver-chosen
        // amount (5_000e6 >> the note's 2_000e6 worth), paying the attacker.
        (bytes memory evil, bytes memory es) =
            _spend(serials[0], attacker, 5_000e6, "evil", memberA1Pk, root, expiry);
        bytes32[] memory proof = TranscriptLib.computeProof(serials, 0);

        uint256 reservesBefore = fund.totalReserves();

        // First conviction succeeds but is BOUNDED to the 2_000e6 first-spend
        // amount (FIX #1) — NOT the attacker's 5_000e6 — and is covered by
        // seizure, so the fund is untouched.
        vm.prank(relayer);
        vault.reconcile(root, serials[0], proof, evil, es);
        assertEq(
            iou1155().balanceOf(attacker, _id(sarrafA)),
            2_000e6,
            "payout bounded to the note's first-spend worth, not the carver-chosen amount"
        );
        assertEq(usdt.balanceOf(attacker), 0, "no insurance drawn: seizure covered the bounded payout");
        assertEq(fund.totalReserves(), reservesBefore, "fund untouched by the first conviction");

        // Every REPLAY of the conviction now reverts (FIX #2 anti-replay), so
        // the fund can never be drained by resubmission.
        for (uint256 i; i < 3; ++i) {
            vm.prank(relayer);
            (bool ok, bytes memory ret) =
                address(vault).call(abi.encodeCall(INoteVault.reconcile, (root, serials[0], proof, evil, es)));
            assertFalse(ok, "replayed conviction must revert");
            assertEq(_reason(ret), "ALREADY_CONVICTED", "replay rejected by the anti-replay guard");
        }

        // Attacker gained only the bounded 2_000e6 IOU; the 9_000e6 fund is intact.
        assertEq(usdt.balanceOf(attacker), 0, "attacker drew nothing from the fund");
        assertEq(fund.totalReserves(), 9_000e6, "fund fully intact after replays");
    }

    /// Extract a Solidity revert-string reason from returndata (selector 0x08c379a0).
    function _reason(bytes memory ret) internal pure returns (string memory) {
        if (ret.length < 4 + 32) return "";
        bytes memory sliced = new bytes(ret.length - 4);
        for (uint256 i; i < sliced.length; ++i) {
            sliced[i] = ret[i + 4];
        }
        return abi.decode(sliced, (string));
    }
}
