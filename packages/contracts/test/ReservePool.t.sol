// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArmBase} from "./ArmBase.sol";

/// Arm A unit tests for ReservePool + InsuranceFund money paths beyond the
/// referee suite: totals accounting, zero/boundary amounts, migration edges,
/// fund bucket cascades.
contract ReservePoolArmTest is ArmBase {
    function setUp() public override {
        super.setUp();
        _certify(sarrafA);
        _addMember(sarrafA, memberA1);
    }

    // --------------------------------------------------------------- deposits

    function test_deposit_zeroAmount_reverts() public {
        vm.prank(sarrafA);
        vm.expectRevert(bytes("ReservePool: zero amount"));
        pool.deposit(0);
    }

    function test_totalDeposits_tracksDepositRedeemAndSurvivesMigrate() public {
        assertEq(pool.totalDeposits(), 100_000e6); // from _certify
        _issueBacked(sarrafA, memberA1, 40_000e6);
        assertEq(pool.totalDeposits(), 140_000e6);

        vm.prank(memberA1);
        pool.redeem(sarrafA, 15_000e6);
        assertEq(pool.totalDeposits(), 125_000e6, "redeem shrinks TVL by the full amount");

        // Migration moves attribution but not TVL.
        _certify(sarrafB);
        vm.prank(sarrafB);
        sarrafRegistry.setAccepting(true);
        _deposit(outsider, 50_000_000e6); // push floor to the cap
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + 1 days + 1);
            vm.prank(sarrafA);
            sarrafRegistry.evaluate();
        }
        assertFalse(sarrafRegistry.isCertified(sarrafA));
        uint256 tvlBefore = pool.totalDeposits();
        vm.prank(memberA1);
        pool.migrate(sarrafA, sarrafB, 10_000e6);
        assertEq(pool.totalDeposits(), tvlBefore, "migrate conserves TVL");
    }

    /// The pool's USDT balance always equals totalDeposits (fees leave to the
    /// fund, payouts to holders, in the same transaction).
    function test_poolUsdtBalance_equalsTotalDeposits() public {
        _issueBacked(sarrafA, memberA1, 40_000e6);
        vm.prank(memberA1);
        pool.redeem(sarrafA, 39_999_999_999); // odd amount => odd fee
        assertEq(usdt.balanceOf(address(pool)), pool.totalDeposits(), "pool holds exactly TVL");
    }

    // ---------------------------------------------------------------- issue

    function test_issue_zeroAmount_reverts() public {
        vm.prank(sarrafA);
        vm.expectRevert(bytes("ReservePool: zero amount"));
        pool.issue(memberA1, 0);
    }

    function test_issue_headroomAccountsForPriorIssuance() public {
        _issueBacked(sarrafA, memberA1, 60_000e6); // backing 160k, outstanding 60k
        vm.prank(sarrafA);
        pool.issue(memberA1, 100_000e6); // exactly the remaining headroom
        vm.prank(sarrafA);
        vm.expectRevert(bytes("ReservePool: unfunded issuance"));
        pool.issue(memberA1, 1);
    }

    // --------------------------------------------------------------- redeem

    function test_redeem_tinyAmount_feeRoundsToZero() public {
        _issueBacked(sarrafA, memberA1, 1_000e6);
        vm.prank(memberA1);
        pool.redeem(sarrafA, 111); // fee = 111*90/10000 = 0
        assertEq(usdt.balanceOf(memberA1), 111, "full payout when fee rounds to zero");
        assertEq(fund.totalReserves(), 0);
    }

    function testFuzz_redeem_conservesValue(uint256 amount) public {
        amount = bound(amount, 1, 500_000e6);
        _issueBacked(sarrafA, memberA1, 500_000e6);
        uint256 tvlBefore = pool.totalDeposits();

        vm.prank(memberA1);
        pool.redeem(sarrafA, amount);

        // holder payout + fund fee == amount released from backing.
        assertEq(
            usdt.balanceOf(memberA1) + usdt.balanceOf(address(fund)),
            amount,
            "no value created or destroyed by redemption"
        );
        assertEq(pool.totalDeposits(), tvlBefore - amount);
        assertEq(usdt.balanceOf(address(fund)), fund.totalReserves(), "fund balance backs its books");
    }

    // -------------------------------------------------------------- migrate

    function _setupMigration() internal {
        _issueBacked(sarrafA, memberA1, 50_000e6);
        _certify(sarrafB);
        vm.prank(sarrafB);
        sarrafRegistry.setAccepting(true);
        _deposit(outsider, 50_000_000e6);
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + 1 days + 1);
            vm.prank(sarrafA);
            sarrafRegistry.evaluate();
        }
        assertFalse(sarrafRegistry.isCertified(sarrafA));
    }

    function test_migrate_toDecertifiedAcceptingSarraf_reverts() public {
        _setupMigration();
        // sarrafB loses certification too; accepting alone is not consent the
        // protocol honors ("consenting CERTIFIED one").
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + 1 days + 1);
            vm.prank(sarrafB);
            sarrafRegistry.evaluate();
        }
        assertFalse(sarrafRegistry.isCertified(sarrafB));

        vm.prank(memberA1);
        vm.expectRevert(bytes("ReservePool: toSarraf not certified"));
        pool.migrate(sarrafA, sarrafB, 10_000e6);
    }

    function test_migrate_nonMemberHolder_movesValueWithoutRehome() public {
        _setupMigration();
        // Hand tranche IOU to a non-member holder.
        vm.prank(memberA1);
        iou.safeTransferFrom(memberA1, recipient1, _id(sarrafA), 20_000e6, "");

        vm.prank(recipient1);
        pool.migrate(sarrafA, sarrafB, 20_000e6);

        assertEq(iou.balanceOf(recipient1, _id(sarrafB)), 20_000e6, "holder migrated 1:1");
        assertEq(registry.sarrafOf(recipient1), address(0), "no membership conjured for a holder");
        assertEq(registry.sarrafOf(memberA1), sarrafA, "unrelated member untouched");
    }

    function test_migrate_memberOfDifferentSarraf_keepsTheirSponsor() public {
        _setupMigration();
        _addMember(sarrafB, memberA2);
        vm.prank(memberA1);
        iou.safeTransferFrom(memberA1, memberA2, _id(sarrafA), 5_000e6, "");

        vm.prank(memberA2);
        pool.migrate(sarrafA, sarrafB, 5_000e6);
        assertEq(registry.sarrafOf(memberA2), sarrafB, "sponsor unchanged (was already B)");
    }

    function test_migrate_beyondHolderBalance_reverts() public {
        _setupMigration();
        vm.prank(memberA1);
        vm.expectRevert(bytes("IouToken: burn exceeds balance"));
        pool.migrate(sarrafA, sarrafB, 50_000e6 + 1);
    }

    // ------------------------------------------------------- insurance fund

    function test_fund_claimsDrainBucketsAndKeepPartition() public {
        _issueBacked(sarrafA, memberA1, 1_000_000e6);
        vm.prank(memberA1);
        pool.redeem(sarrafA, 1_000_000e6); // reserves 9_000e6, 4500/4500

        // Drain maintenance below half of the next claim: claim 8_000 takes
        // 4_000 from each; then a second claim must cascade.
        vm.prank(address(vault));
        fund.payClaim(recipient1, 8_000e6);
        assertEq(fund.totalReserves(), 1_000e6);
        assertEq(
            fund.overseeingShare() + fund.maintenanceShare(), fund.totalReserves(), "books stay partitioned"
        );

        vm.prank(address(vault));
        fund.payClaim(recipient1, 1_000e6); // must drain whatever is left
        assertEq(fund.totalReserves(), 0);
        assertEq(fund.overseeingShare(), 0);
        assertEq(fund.maintenanceShare(), 0);
    }

    function test_fund_claimBeyondReserves_reverts() public {
        _issueBacked(sarrafA, memberA1, 100_000e6);
        vm.prank(memberA1);
        pool.redeem(sarrafA, 100_000e6); // reserves 900e6
        vm.prank(address(vault));
        vm.expectRevert(bytes("InsuranceFund: insufficient reserves"));
        fund.payClaim(recipient1, 900e6 + 1);
    }

    function test_fund_recordFee_onlyPool() public {
        vm.prank(attacker);
        vm.expectRevert(bytes("InsuranceFund: only pool"));
        fund.recordFee(1);
    }

    function testFuzz_fund_splitPartitionsEveryFee(uint256 fee) public {
        fee = bound(fee, 0, 1e18);
        vm.prank(address(pool));
        fund.recordFee(fee);
        assertEq(fund.overseeingShare() + fund.maintenanceShare(), fee, "split partitions the fee");
        assertLe(
            fund.overseeingShare() - fund.maintenanceShare(), 1, "buckets differ by at most the odd wei"
        );
    }
}
