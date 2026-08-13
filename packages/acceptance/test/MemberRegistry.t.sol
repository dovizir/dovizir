// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AcceptanceBase} from "./AcceptanceBase.sol";
import {IMemberRegistry} from "../src/interfaces/IDovizir.sol";

/// IMemberRegistry acceptance: sarraf-initiated onboarding, single sponsor,
/// sponsor-only removal, migrate-flow-only rehoming (IDovizir.sol;
/// PROTOCOL.md §1).
contract MemberRegistryTest is AcceptanceBase {
    function setUp() public override {
        super.setUp();
        _certify(sarrafA);
    }

    /// IDovizir.sol: addMember caller = certified sarraf; records the caller
    /// as the member's single sponsor and emits MemberAdded.
    function test_addMember_byCertifiedSarraf_recordsSponsor_emitsMemberAdded() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit IMemberRegistry.MemberAdded(memberA1, sarrafA);
        vm.prank(sarrafA);
        registry.addMember(memberA1);

        assertTrue(registry.isMember(memberA1), "member recorded");
        assertEq(registry.sarrafOf(memberA1), sarrafA, "sponsor is the calling sarraf");
    }

    /// IDovizir.sol: addMember only by a CERTIFIED sarraf — uncertified
    /// addresses (sarrafB has deposits but no certification; attacker has
    /// nothing) must revert.
    function test_addMember_byUncertifiedCaller_reverts() public {
        _deposit(sarrafB, 10_000e6); // deposits alone do not certify

        vm.prank(sarrafB);
        vm.expectRevert();
        registry.addMember(memberB1);

        vm.prank(attacker);
        vm.expectRevert();
        registry.addMember(memberB1);

        assertFalse(registry.isMember(memberB1), "no membership from uncertified caller");
        assertEq(registry.sarrafOf(memberB1), address(0));
    }

    /// IDovizir.sol: "A member belongs to exactly one sponsoring Sarraf." A
    /// second certified sarraf cannot claim an already-sponsored member.
    function test_addMember_alreadySponsored_reverts() public {
        vm.prank(sarrafA);
        registry.addMember(memberA1);
        _certify(sarrafB);

        vm.prank(sarrafB);
        vm.expectRevert();
        registry.addMember(memberA1);

        assertEq(registry.sarrafOf(memberA1), sarrafA, "sponsorship unchanged");
    }

    /// IDovizir.sol: removeMember caller = the member's sponsoring sarraf;
    /// clears membership.
    function test_removeMember_bySponsor_clearsMembership() public {
        vm.prank(sarrafA);
        registry.addMember(memberA1);

        vm.prank(sarrafA);
        registry.removeMember(memberA1);

        assertFalse(registry.isMember(memberA1), "membership cleared");
        assertEq(registry.sarrafOf(memberA1), address(0), "sponsor cleared to 0x0");
    }

    /// IDovizir.sol: only THAT sponsor may remove — another certified sarraf
    /// or a random address must revert.
    function test_removeMember_byNonSponsor_reverts() public {
        vm.prank(sarrafA);
        registry.addMember(memberA1);
        _certify(sarrafB);

        vm.prank(sarrafB);
        vm.expectRevert();
        registry.removeMember(memberA1);

        vm.prank(attacker);
        vm.expectRevert();
        registry.removeMember(memberA1);

        assertTrue(registry.isMember(memberA1), "membership intact");
        assertEq(registry.sarrafOf(memberA1), sarrafA);
    }

    /// PROTOCOL.md §1 / IDovizir.sol: rehome happens only via the
    /// pool.migrate flow (or a registry guard equivalent) — direct calls from
    /// EOAs (attacker, would-be new sponsor) must revert.
    function test_rehome_directCall_reverts() public {
        vm.prank(sarrafA);
        registry.addMember(memberA1);
        _certify(sarrafB);
        vm.prank(sarrafB);
        sarrafRegistry.setAccepting(true);

        vm.prank(sarrafB); // even the accepting new sarraf cannot rehome directly
        vm.expectRevert();
        registry.rehome(memberA1, sarrafB);

        vm.prank(attacker);
        vm.expectRevert();
        registry.rehome(memberA1, attacker);

        assertEq(registry.sarrafOf(memberA1), sarrafA, "sponsorship unchanged by direct rehome");
    }

    /// IDovizir.sol / IReservePool.migrate: a successful holder migration
    /// rehomes the member to the new sarraf and emits MemberRehomed.
    function test_rehome_viaMigrateFlow_updatesSponsor_emitsMemberRehomed() public {
        _addMember(sarrafA, memberA1);
        _issueBacked(sarrafA, memberA1, 50_000e6);
        _certify(sarrafB);
        vm.prank(sarrafB);
        sarrafRegistry.setAccepting(true);
        _decertify(sarrafA); // migrate requires fromSarraf no longer certified

        vm.expectEmit(true, true, true, true, address(registry));
        emit IMemberRegistry.MemberRehomed(memberA1, sarrafA, sarrafB);
        vm.prank(memberA1);
        pool.migrate(sarrafA, sarrafB, 30_000e6);

        assertEq(registry.sarrafOf(memberA1), sarrafB, "member rehomed to accepting sarraf");
        assertTrue(registry.isMember(memberA1), "still a member");
    }

    /// IDovizir.sol: views default to empty for unknown addresses.
    function test_views_defaultEmptyForNonMembers() public view {
        assertFalse(registry.isMember(outsider));
        assertEq(registry.sarrafOf(outsider), address(0), "sarrafOf is 0x0 if none");
    }
}
