// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AcceptanceBase} from "./AcceptanceBase.sol";
import {IReservePool} from "../src/interfaces/IDovizir.sol";

/// IReservePool acceptance: fully-funded issuance (no headroom in M1), 90 bps
/// redemption fee routed to the InsuranceFund, holder migration
/// (IDovizir.sol; PROTOCOL.md §1).
contract ReservePoolTest is AcceptanceBase {
    function setUp() public override {
        super.setUp();
        _certify(sarrafA); // sarrafA backing starts at CERT_DEPOSIT
        _addMember(sarrafA, memberA1);
    }

    /// IDovizir.sol: deposit pulls the sarraf's mock USDT and credits their
    /// tranche backing; emits Deposited.
    function test_deposit_pullsUsdt_increasesBacking_emitsDeposited() public {
        uint256 backingBefore = pool.backingOf(sarrafA);
        _fund(sarrafA, 10_000e6);
        vm.startPrank(sarrafA);
        usdt.approve(address(pool), 10_000e6);
        vm.expectEmit(true, true, true, true, address(pool));
        emit IReservePool.Deposited(sarrafA, 10_000e6);
        pool.deposit(10_000e6);
        vm.stopPrank();

        assertEq(usdt.balanceOf(sarrafA), 0, "USDT pulled from sarraf");
        assertEq(pool.backingOf(sarrafA), backingBefore + 10_000e6, "backing credited");
    }

    /// Spec resolution (README.md): deposit MUST be callable by a
    /// not-yet-certified sarraf — the 7-day deposit TWAB is the only path to
    /// certification, so gating deposit on certification would deadlock
    /// ISarrafRegistry.evaluate() once floor > 0. Only issue() is cert-gated.
    function test_deposit_beforeCertification_allowed_buildsTwabBase() public {
        assertFalse(sarrafRegistry.isCertified(sarrafB));
        _deposit(sarrafB, 5_000e6);
        assertEq(pool.backingOf(sarrafB), 5_000e6, "uncertified sarraf can build backing/TWAB");
    }

    /// IDovizir.sol: deposit pulls via the ERC-20 allowance — without an
    /// approval it must revert and credit nothing.
    function test_deposit_withoutAllowance_reverts() public {
        uint256 backingBefore = pool.backingOf(sarrafA);
        _fund(sarrafA, 1_000e6);
        vm.prank(sarrafA);
        vm.expectRevert();
        pool.deposit(1_000e6);
        assertEq(pool.backingOf(sarrafA), backingBefore, "no backing without pulled funds");
    }

    /// IDovizir.sol: issue caller = certified sarraf, to = their member; mints
    /// the sarraf's tranche 1:1, increases outstanding, emits Issued.
    function test_issue_byCertifiedSarraf_toOwnMember_mintsTranche_emitsIssued() public {
        vm.expectEmit(true, true, true, true, address(pool));
        emit IReservePool.Issued(sarrafA, memberA1, 40_000e6);
        vm.prank(sarrafA);
        pool.issue(memberA1, 40_000e6);

        assertEq(iou1155().balanceOf(memberA1, _id(sarrafA)), 40_000e6, "tranche IOU minted 1:1");
        assertEq(pool.outstandingOf(sarrafA), 40_000e6, "outstanding tracks issuance");
    }

    /// IDovizir.sol: issue only by a CERTIFIED sarraf. sarrafB is certified,
    /// onboards a member, then loses certification — issuance must then revert.
    function test_issue_byDecertifiedSarraf_reverts() public {
        _certify(sarrafB);
        _addMember(sarrafB, memberB1);
        _decertify(sarrafB);

        vm.prank(sarrafB);
        vm.expectRevert();
        pool.issue(memberB1, 1_000e6); // backing (CERT_DEPOSIT) exists; only certification is missing

        assertEq(pool.outstandingOf(sarrafB), 0, "no issuance without certification");
        assertEq(iou1155().balanceOf(memberB1, _id(sarrafB)), 0);
    }

    /// IDovizir.sol: issue only to the sarraf's OWN member — a non-member
    /// recipient reverts.
    function test_issue_toNonMember_reverts() public {
        vm.prank(sarrafA);
        vm.expectRevert();
        pool.issue(outsider, 1_000e6);
        assertEq(pool.outstandingOf(sarrafA), 0);
        assertEq(iou1155().balanceOf(outsider, _id(sarrafA)), 0);
    }

    /// IDovizir.sol: issue only to the sarraf's OWN member — another sarraf's
    /// member reverts.
    function test_issue_toAnotherSarrafsMember_reverts() public {
        _certify(sarrafB);
        _addMember(sarrafB, memberB1);

        vm.prank(sarrafA);
        vm.expectRevert();
        pool.issue(memberB1, 1_000e6);
        assertEq(pool.outstandingOf(sarrafA), 0);
        assertEq(iou1155().balanceOf(memberB1, _id(sarrafA)), 0);
    }

    /// PROTOCOL.md §1: "fully-funded issuance only" — outstanding may reach
    /// backing exactly, and one unit beyond must revert (no headroom, no
    /// CreditOracle enforcement in M1).
    function test_issue_totalOutstandingCappedAtBacking_fundedOnly() public {
        uint256 backing = pool.backingOf(sarrafA);
        vm.prank(sarrafA);
        pool.issue(memberA1, backing); // exactly fully funded: allowed

        assertEq(pool.outstandingOf(sarrafA), backing);

        vm.prank(sarrafA);
        vm.expectRevert();
        pool.issue(memberA1, 1); // one unit of unfunded issuance: never

        assertEq(pool.outstandingOf(sarrafA), backing, "outstanding stays == backing");
    }

    /// IDovizir.sol: redeem burns the holder's tranche IOU, pays USDT minus
    /// the 90 bps fee, routes the fee to the InsuranceFund, decreases backing
    /// and outstanding, emits Redeemed(sarraf, holder, amount, fee).
    function test_redeem_paysNetOfFee_feeLandsInInsuranceFund_emitsRedeemed() public {
        vm.prank(sarrafA);
        pool.issue(memberA1, 50_000e6);

        uint256 amount = 20_000e6;
        uint256 fee = _fee(amount); // 90 bps => 180e6
        assertEq(fee, 180e6, "fixture sanity");
        uint256 backingBefore = pool.backingOf(sarrafA);

        vm.expectEmit(true, true, true, true, address(pool));
        emit IReservePool.Redeemed(sarrafA, memberA1, amount, fee);
        vm.prank(memberA1);
        pool.redeem(sarrafA, amount);

        assertEq(usdt.balanceOf(memberA1), amount - fee, "holder paid net of 90 bps");
        assertEq(iou1155().balanceOf(memberA1, _id(sarrafA)), 30_000e6, "tranche IOU burned");
        assertEq(pool.outstandingOf(sarrafA), 30_000e6, "outstanding reduced by full amount");
        assertEq(pool.backingOf(sarrafA), backingBefore - amount, "backing released in full");
        assertEq(fund.totalReserves(), fee, "fee lands in the InsuranceFund");
    }

    /// IDovizir.sol: redeem is holder-initiated with no membership
    /// requirement — an IOU holder who is not a member (received the tranche
    /// by transfer) can redeem.
    function test_redeem_byNonMemberHolder_allowed() public {
        vm.prank(sarrafA);
        pool.issue(memberA1, 10_000e6);
        vm.prank(memberA1);
        iou1155().safeTransferFrom(memberA1, recipient1, _id(sarrafA), 10_000e6, "");
        _approveOperators(recipient1);

        vm.prank(recipient1);
        pool.redeem(sarrafA, 10_000e6);

        assertEq(usdt.balanceOf(recipient1), 10_000e6 - _fee(10_000e6), "non-member holder redeems");
        assertEq(pool.outstandingOf(sarrafA), 0);
    }

    /// Fuzz: fee is exactly amount*90/10_000 (rounded DOWN) for any amount.
    function testFuzz_redeem_feeIsNinetyBpsRoundedDown(uint256 amount) public {
        amount = bound(amount, 1, 100_000e6);
        _issueBacked(sarrafA, memberA1, 100_000e6);

        uint256 fee = (amount * 90) / 10_000;
        vm.prank(memberA1);
        pool.redeem(sarrafA, amount);

        assertEq(usdt.balanceOf(memberA1), amount - fee, "net payout");
        assertEq(fund.totalReserves(), fee, "fee accrual");
        assertEq(pool.outstandingOf(sarrafA), 100_000e6 - amount);
    }

    /// IDovizir.sol: redeem burns the HOLDER's IOUs — redeeming more than the
    /// caller's tranche balance reverts.
    function test_redeem_beyondHolderBalance_reverts() public {
        vm.prank(sarrafA);
        pool.issue(memberA1, 1_000e6);

        vm.prank(memberA1);
        vm.expectRevert();
        pool.redeem(sarrafA, 1_000e6 + 1);

        assertEq(pool.outstandingOf(sarrafA), 1_000e6, "nothing redeemed");
        assertEq(usdt.balanceOf(memberA1), 0);
    }

    /// IDovizir.sol migrate: burn old-tranche IOU, move backing attribution,
    /// mint new-tranche IOU, emit Migrated. Requires fromSarraf decertified
    /// and toSarraf accepting.
    function test_migrate_happyPath_movesBackingOutstandingAndTranche_emitsMigrated() public {
        _issueBacked(sarrafA, memberA1, 50_000e6);
        _certify(sarrafB);
        vm.prank(sarrafB);
        sarrafRegistry.setAccepting(true);
        _decertify(sarrafA);

        uint256 backingABefore = pool.backingOf(sarrafA);
        uint256 backingBBefore = pool.backingOf(sarrafB);

        vm.expectEmit(true, true, true, true, address(pool));
        emit IReservePool.Migrated(memberA1, sarrafA, sarrafB, 30_000e6);
        vm.prank(memberA1);
        pool.migrate(sarrafA, sarrafB, 30_000e6);

        assertEq(iou1155().balanceOf(memberA1, _id(sarrafA)), 20_000e6, "old tranche burned");
        assertEq(iou1155().balanceOf(memberA1, _id(sarrafB)), 30_000e6, "new tranche minted 1:1");
        assertEq(pool.outstandingOf(sarrafA), 20_000e6, "old outstanding reduced");
        assertEq(pool.outstandingOf(sarrafB), 30_000e6, "new outstanding increased");
        assertEq(pool.backingOf(sarrafA), backingABefore - 30_000e6, "backing attribution moved out");
        assertEq(pool.backingOf(sarrafB), backingBBefore + 30_000e6, "backing attribution moved in");
    }

    /// IDovizir.sol: migrate "Reverts if fromSarraf still certified".
    function test_migrate_fromSarrafStillCertified_reverts() public {
        _issueBacked(sarrafA, memberA1, 10_000e6);
        _certify(sarrafB);
        vm.prank(sarrafB);
        sarrafRegistry.setAccepting(true);

        vm.prank(memberA1);
        vm.expectRevert();
        pool.migrate(sarrafA, sarrafB, 10_000e6); // sarrafA IS still certified

        assertEq(iou1155().balanceOf(memberA1, _id(sarrafA)), 10_000e6, "nothing moved");
        assertEq(pool.outstandingOf(sarrafB), 0);
    }

    /// IDovizir.sol: migrate "Reverts ... if toSarraf not accepting"
    /// (isAccepting defaults to false until setAccepting(true)).
    function test_migrate_toSarrafNotAccepting_reverts() public {
        _issueBacked(sarrafA, memberA1, 10_000e6);
        _certify(sarrafB); // certified but never called setAccepting(true)
        _decertify(sarrafA);

        vm.prank(memberA1);
        vm.expectRevert();
        pool.migrate(sarrafA, sarrafB, 10_000e6);

        assertEq(iou1155().balanceOf(memberA1, _id(sarrafA)), 10_000e6, "nothing moved");
        assertEq(pool.outstandingOf(sarrafB), 0);
    }

    /// backingOf/outstandingOf stay mutually consistent across a
    /// deposit → issue → redeem lifecycle, with backing >= outstanding
    /// throughout (funded-only M1).
    function test_backingAndOutstanding_consistentAcrossLifecycle() public {
        uint256 b0 = pool.backingOf(sarrafA); // CERT_DEPOSIT
        assertEq(pool.outstandingOf(sarrafA), 0);

        _deposit(sarrafA, 40_000e6);
        assertEq(pool.backingOf(sarrafA), b0 + 40_000e6);

        vm.prank(sarrafA);
        pool.issue(memberA1, 60_000e6);
        assertEq(pool.outstandingOf(sarrafA), 60_000e6);
        assertGe(pool.backingOf(sarrafA), pool.outstandingOf(sarrafA), "backing covers outstanding");

        vm.prank(memberA1);
        pool.redeem(sarrafA, 25_000e6);
        assertEq(pool.outstandingOf(sarrafA), 35_000e6);
        assertEq(pool.backingOf(sarrafA), b0 + 40_000e6 - 25_000e6);
        assertGe(pool.backingOf(sarrafA), pool.outstandingOf(sarrafA), "backing covers outstanding");
    }
}
