// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ArmBase} from "./ArmBase.sol";
import {KycRegistry} from "../src/KycRegistry.sol";

/// The KYC attestation registry — Phase 5 (G7), the on-chain footprint of the
/// decided tier model (mvp.md "KYC tiers"):
///
///   0  registration    OTP-verified contact          every consumer
///   1  legal identity  ID + selfie, local provider   above a threshold
///   2  shop            + address & business checks   sellers
///
/// Only the ATTESTATION lives on-chain: who vouched, what level, when. The
/// documents stay with the sarraf and their provider — publishing them would
/// be the exact privacy failure the protocol exists to avoid. Enforcement of
/// tier ceilings is desk/app-side in the pilot: the frozen token interfaces
/// cannot gain KYC gates without breaking the referee suite, and that is a
/// deliberate boundary, not an accident.
contract KycRegistryTest is ArmBase {
    KycRegistry internal kyc;

    function setUp() public override {
        super.setUp();
        _certify(sarrafA);
        _certify(sarrafB);
        _addMember(sarrafA, memberA1);
        kyc = new KycRegistry(registry, sarrafRegistry);
    }

    // ------------------------------------------------------------ attesting

    function test_sponsoringSarraf_attestsTheirMember() public {
        vm.prank(sarrafA);
        kyc.attest(memberA1, 1);

        assertEq(kyc.tierOf(memberA1), 1, "tier recorded");
        (uint8 tier, address by, uint64 at) = kyc.attestationOf(memberA1);
        assertEq(tier, 1);
        assertEq(by, sarrafA, "the voucher is on record");
        assertEq(at, uint64(block.timestamp), "and when they vouched");
    }

    function test_unattestedMember_isTierZero() public view {
        assertEq(kyc.tierOf(memberA1), 0, "registration-only until attested higher");
    }

    /// Accountability is the whole point: only the sarraf who SPONSORS a
    /// member may vouch for them — tier 1 losses land on the voucher.
    function test_otherSarraf_cannotAttest() public {
        vm.prank(sarrafB);
        vm.expectRevert(bytes("Kyc: not their sarraf"));
        kyc.attest(memberA1, 1);
    }

    function test_nonSarraf_cannotAttest() public {
        vm.prank(outsider);
        vm.expectRevert(bytes("Kyc: not their sarraf"));
        kyc.attest(memberA1, 1);
    }

    function test_decertifiedSarraf_cannotAttest() public {
        // certification is the maintainer's lever (tier 3): losing it must
        // also revoke the power to vouch for others
        _decertify(sarrafA);
        vm.prank(sarrafA);
        vm.expectRevert(bytes("Kyc: not certified"));
        kyc.attest(memberA1, 1);
    }

    function test_tierAboveShop_rejected() public {
        vm.prank(sarrafA);
        vm.expectRevert(bytes("Kyc: bad tier"));
        kyc.attest(memberA1, 3);
    }

    // ----------------------------------------------------------- downgrades

    function test_sarraf_mayDowngrade() public {
        vm.startPrank(sarrafA);
        kyc.attest(memberA1, 2);
        kyc.attest(memberA1, 1); // KYC expiry, a failed re-check, fraud
        vm.stopPrank();
        assertEq(kyc.tierOf(memberA1), 1, "downgrade is a normal attestation");
    }

    function test_reattestation_updatesTimestampAndVoucher() public {
        vm.prank(sarrafA);
        kyc.attest(memberA1, 1);
        vm.warp(block.timestamp + 365 days);
        vm.prank(sarrafA);
        kyc.attest(memberA1, 1); // annual re-verification
        (, , uint64 at) = kyc.attestationOf(memberA1);
        assertEq(at, uint64(block.timestamp), "re-attestation refreshes the clock");
    }

    // -------------------------------------------------------------- nothing
    // resembling PII can even be expressed: the interface takes an address and
    // a number. This test exists as documentation of that boundary.

    function test_interfaceCarriesNoPii() public {
        vm.prank(sarrafA);
        kyc.attest(memberA1, 2);
        (uint8 tier, address by, uint64 at) = kyc.attestationOf(memberA1);
        // The complete on-chain record: level, voucher, timestamp. Nothing else
        // exists to leak.
        assertEq(tier, 2);
        assertEq(by, sarrafA);
        assertGt(at, 0);
    }

    // helper: push sarrafA below the floor and evaluate until decertified
    function _decertify(address sarraf) internal {
        _certify(sarrafB);
        vm.prank(sarrafB);
        sarrafRegistry.setAccepting(true);
        _deposit(outsider, 50_000_000e6);
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + 1 days + 1);
            vm.prank(sarraf);
            sarrafRegistry.evaluate();
        }
    }
}
