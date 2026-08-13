// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AcceptanceBase} from "./AcceptanceBase.sol";
import {ISarrafRegistry} from "../src/interfaces/IDovizir.sol";

/// ISarrafRegistry acceptance: TWAB certification floor min(totalDeposits/5,
/// $1M), 100%-enter / 90%-exit hysteresis over 3 consecutive evaluations,
/// 24h evaluate rate limit, accepting flag (IDovizir.sol; PROTOCOL.md §1).
///
/// Interpretations recorded in README.md:
///  - evaluate() evaluates msg.sender; the 24h rate limit is per sarraf.
///  - "consecutive evaluations" means successive evaluate() CALLS (however
///    far apart in time, as long as each pair is >= 24h apart).
///  - floor() reads SPOT totalDeposits (only the sarraf's own balance is
///    time-weighted).
contract SarrafRegistryTest is AcceptanceBase {
    uint256 internal constant LOW_BAR = (1_000_000e6 * 90) / 100; // 90% of capped floor

    /// IDovizir.sol: floor = min(totalDeposits/5, 1_000_000e6). Checked at 0,
    /// below the cap, exactly at the cap boundary, and beyond it.
    function test_floor_isMinOfTotalDepositsOverFiveAndOneMillionCap() public {
        assertEq(sarrafRegistry.floor(), 0, "no deposits => floor 0");

        _deposit(sarrafA, 250_000e6);
        _deposit(sarrafB, 250_000e6);
        assertEq(sarrafRegistry.floor(), 100_000e6, "500k total => floor 100k");

        _deposit(whale, 2_000_000e6);
        assertEq(sarrafRegistry.floor(), 500_000e6, "2.5M total => floor 500k");

        _deposit(whale, 7_500_000e6);
        assertEq(sarrafRegistry.floor(), FLOOR_CAP, "10M total => floor capped at $1M");

        _deposit(whale, 5_000_000e6);
        assertEq(sarrafRegistry.floor(), FLOOR_CAP, "cap binds for any larger TVL");
    }

    /// IDovizir.sol: certified iff 7-day TWAB of deposit >= floor; entering
    /// emits Certified. A constant balance held a full 7 days IS the TWAB.
    function test_certification_sevenDayTwabAtFloor_certifies_emitsCertified() public {
        _deposit(sarrafA, 100_000e6);
        vm.warp(block.timestamp + 7 days);

        assertEq(sarrafRegistry.twabOf(sarrafA), 100_000e6, "constant balance over the window is the TWAB");
        assertFalse(sarrafRegistry.isCertified(sarrafA), "not certified before evaluate()");

        vm.expectEmit(true, true, true, true, address(sarrafRegistry));
        emit ISarrafRegistry.Certified(sarrafA);
        vm.prank(sarrafA);
        sarrafRegistry.evaluate();

        assertTrue(sarrafRegistry.isCertified(sarrafA));
    }

    /// IDovizir.sol: certification requires TWAB >= floor — a small sarraf in
    /// a large pool (floor at the $1M cap) is denied.
    function test_certification_twabBelowFloor_denied() public {
        _deposit(whale, 10_000_000e6); // floor => $1M cap
        _deposit(sarrafB, 100_000e6);
        vm.warp(block.timestamp + 7 days);

        vm.prank(sarrafB);
        sarrafRegistry.evaluate();

        assertFalse(sarrafRegistry.isCertified(sarrafB), "TWAB 100k < floor 1M must not certify");
    }

    /// IDovizir.sol: "evaluate() callable at most once per 24h period" (per
    /// sarraf) — a second call within 24h reverts; after 24h it succeeds.
    function test_evaluate_rateLimitedToOncePerTwentyFourHours() public {
        _certify(sarrafA); // ends with an evaluate() call

        vm.warp(block.timestamp + 12 hours);
        vm.prank(sarrafA);
        vm.expectRevert();
        sarrafRegistry.evaluate();

        vm.warp(block.timestamp + 12 hours + 1);
        vm.prank(sarrafA);
        sarrafRegistry.evaluate(); // >24h since last: allowed

        assertTrue(sarrafRegistry.isCertified(sarrafA), "state intact across rate-limited window");
    }

    /// TWAB is genuinely time-weighted: 100k held half the 7-day window and
    /// 200k the other half averages to 150k (0.1% tolerance for per-second
    /// accounting differences).
    function test_twab_isTimeWeightedOverSevenDayWindow() public {
        _deposit(sarrafA, 100_000e6);
        vm.warp(block.timestamp + 3.5 days);
        _deposit(sarrafA, 100_000e6); // balance now 200k
        vm.warp(block.timestamp + 3.5 days);

        assertApproxEqRel(
            sarrafRegistry.twabOf(sarrafA),
            150_000e6,
            0.001e18,
            "TWAB must time-weight the balance, not snapshot it"
        );
    }

    /// PROTOCOL.md §1 hysteresis: once certified, three CONSECUTIVE
    /// evaluations with TWAB < 90% of floor decertify (Decertified emitted on
    /// the third). The middle gap is 3 days — consecutive counts evaluate()
    /// calls, not calendar days.
    function test_hysteresis_threeConsecutiveLowEvaluations_decertify() public {
        _certify(sarrafA); // TWAB 100k
        _deposit(whale, 10_000_000e6); // floor => $1M; 100k < 900k = low
        assertLt(sarrafRegistry.twabOf(sarrafA), LOW_BAR, "fixture: below 90% of floor");

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(sarrafA);
        sarrafRegistry.evaluate(); // low #1
        assertTrue(sarrafRegistry.isCertified(sarrafA), "1 low evaluation must NOT decertify");

        vm.warp(block.timestamp + 3 days); // wider gap: still "consecutive"
        vm.prank(sarrafA);
        sarrafRegistry.evaluate(); // low #2
        assertTrue(sarrafRegistry.isCertified(sarrafA), "2 low evaluations must NOT decertify");

        vm.warp(block.timestamp + 1 days + 1);
        vm.expectEmit(true, true, true, true, address(sarrafRegistry));
        emit ISarrafRegistry.Decertified(sarrafA);
        vm.prank(sarrafA);
        sarrafRegistry.evaluate(); // low #3 => drop

        assertFalse(sarrafRegistry.isCertified(sarrafA), "3 consecutive low evaluations decertify");
    }

    /// PROTOCOL.md §1 hysteresis: a recovered evaluation between low ones
    /// RESETS the consecutive-low counter. Sequence: 2 low, 1 recovered
    /// (certified stays), then it takes 3 MORE lows — not 1 — to drop.
    function test_hysteresis_recoveredEvaluationResetsConsecutiveLowCounter() public {
        _certify(sarrafA); // deposits 100k
        _addMember(sarrafA, memberA1);
        _deposit(whale, 10_000_000e6); // floor => $1M

        // low #1 and low #2
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(sarrafA);
        sarrafRegistry.evaluate();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(sarrafA);
        sarrafRegistry.evaluate();
        assertTrue(sarrafRegistry.isCertified(sarrafA), "2 lows: still certified");

        // recovery: top up to 1.1M and hold the full window => TWAB 1.1M >= 900k
        _deposit(sarrafA, 1_000_000e6);
        vm.warp(block.timestamp + 7 days);
        assertGe(sarrafRegistry.twabOf(sarrafA), LOW_BAR, "fixture: recovered above 90% of floor");
        vm.prank(sarrafA);
        sarrafRegistry.evaluate(); // recovered evaluation
        assertTrue(sarrafRegistry.isCertified(sarrafA), "2 low + 1 recovered != drop");

        // drain backing again: issue to a member who redeems 1.05M => balance 50k
        vm.prank(sarrafA);
        pool.issue(memberA1, 1_050_000e6);
        vm.prank(memberA1);
        pool.redeem(sarrafA, 1_050_000e6);
        vm.warp(block.timestamp + 7 days); // TWAB decays to 50k; floor still capped at 1M
        assertEq(sarrafRegistry.floor(), FLOOR_CAP, "fixture: floor still at cap");
        assertLt(sarrafRegistry.twabOf(sarrafA), LOW_BAR, "fixture: low again");

        // If the recovery had NOT reset the counter, this evaluation would be
        // the fatal third low. It must not decertify.
        vm.prank(sarrafA);
        sarrafRegistry.evaluate(); // low #1 after reset
        assertTrue(sarrafRegistry.isCertified(sarrafA), "counter was reset by the recovered evaluation");

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(sarrafA);
        sarrafRegistry.evaluate(); // low #2 after reset
        assertTrue(sarrafRegistry.isCertified(sarrafA));

        vm.warp(block.timestamp + 1 days + 1);
        vm.expectEmit(true, true, true, true, address(sarrafRegistry));
        emit ISarrafRegistry.Decertified(sarrafA);
        vm.prank(sarrafA);
        sarrafRegistry.evaluate(); // low #3 after reset => drop
        assertFalse(sarrafRegistry.isCertified(sarrafA));
    }

    /// PROTOCOL.md §1: the exit threshold is STRICTLY below 90% of floor —
    /// TWAB exactly at 90% is not "low", so certification survives any number
    /// of evaluations.
    function test_hysteresis_twabExactlyAtNinetyPercentOfFloor_isNotLow() public {
        _deposit(sarrafA, 900_000e6); // == 90% of the capped floor
        vm.warp(block.timestamp + 7 days);
        vm.prank(sarrafA);
        sarrafRegistry.evaluate(); // floor is 180k here => certified
        assertTrue(sarrafRegistry.isCertified(sarrafA));

        _deposit(whale, 10_000_000e6); // floor => $1M; 90% bar = 900k == TWAB
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + 1 days + 1);
            assertEq(sarrafRegistry.twabOf(sarrafA), 900_000e6, "fixture: TWAB pinned at the bar");
            vm.prank(sarrafA);
            sarrafRegistry.evaluate();
        }
        assertTrue(
            sarrafRegistry.isCertified(sarrafA),
            "TWAB == 90% of floor is not below it; must stay certified"
        );
    }

    /// IDovizir.sol: setAccepting toggles isAccepting for msg.sender;
    /// defaults to false.
    function test_setAccepting_togglesIsAccepting() public {
        assertFalse(sarrafRegistry.isAccepting(sarrafA), "default: not accepting");

        vm.prank(sarrafA);
        sarrafRegistry.setAccepting(true);
        assertTrue(sarrafRegistry.isAccepting(sarrafA));
        assertFalse(sarrafRegistry.isAccepting(sarrafB), "flag is per sarraf");

        vm.prank(sarrafA);
        sarrafRegistry.setAccepting(false);
        assertFalse(sarrafRegistry.isAccepting(sarrafA));
    }
}
