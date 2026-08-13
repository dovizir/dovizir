// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArmBase} from "./ArmBase.sol";

/// Arm A unit tests for SarrafRegistry beyond the referee suite: TWAB window
/// mechanics, checkpoint plumbing, cooldown boundaries, recertification.
contract SarrafRegistryArmTest is ArmBase {
    function test_checkpoint_onlyPool() public {
        vm.prank(attacker);
        vm.expectRevert(bytes("SarrafRegistry: only pool"));
        sarrafRegistry.checkpoint(attacker, 1e30);
    }

    function test_init_onlyOnce() public {
        vm.expectRevert(bytes("SarrafRegistry: already initialized"));
        sarrafRegistry.init(address(pool));
    }

    function test_twab_zeroWithoutDeposits() public view {
        assertEq(sarrafRegistry.twabOf(sarrafA), 0);
    }

    /// A deposit held for only part of the window is weighted by its share of
    /// the window: 70k for 3 of 7 days => 30k.
    function test_twab_partialWindowWeighting() public {
        vm.warp(block.timestamp + 30 days); // deep past so the window is fully formed
        _deposit(sarrafA, 70_000e6);
        vm.warp(block.timestamp + 3 days);
        assertEq(sarrafRegistry.twabOf(sarrafA), 30_000e6, "3/7 of the window at 70k");
    }

    /// Balance changes inside the same second collapse into one checkpoint and
    /// never distort the integral.
    function test_twab_sameSecondCheckpointsCollapse() public {
        _deposit(sarrafA, 10_000e6);
        _deposit(sarrafA, 10_000e6);
        _deposit(sarrafA, 10_000e6); // three checkpoints at the same timestamp
        vm.warp(block.timestamp + 7 days);
        assertEq(sarrafRegistry.twabOf(sarrafA), 30_000e6, "same-second deposits count fully");
    }

    /// Old balance history beyond the window must not inflate the TWAB.
    function test_twab_ignoresHistoryOlderThanWindow() public {
        _deposit(sarrafA, 1_000_000e6);
        vm.warp(block.timestamp + 30 days);

        // Drain nearly all backing via issue+redeem, then wait a full window.
        vm.prank(sarrafA);
        sarrafRegistry.evaluate(); // certify sarrafA (TWAB 1M >= floor 200k)
        assertTrue(sarrafRegistry.isCertified(sarrafA));
        _addMember(sarrafA, memberA1);
        vm.prank(sarrafA);
        pool.issue(memberA1, 999_000e6);
        vm.prank(memberA1);
        pool.redeem(sarrafA, 999_000e6);
        vm.warp(block.timestamp + 7 days);
        assertEq(sarrafRegistry.twabOf(sarrafA), 1_000e6, "only the trailing 7 days count");
    }

    function test_evaluate_cooldownBoundary_exactly24hAllowed() public {
        _certify(sarrafA);
        uint256 last = block.timestamp;
        vm.warp(last + 24 hours - 1);
        vm.prank(sarrafA);
        vm.expectRevert(bytes("SarrafRegistry: cooldown"));
        sarrafRegistry.evaluate();

        vm.warp(last + 24 hours); // >= 24h spacing is allowed
        vm.prank(sarrafA);
        sarrafRegistry.evaluate();
        assertTrue(sarrafRegistry.isCertified(sarrafA));
    }

    function test_recertification_afterDrop_requiresFullFloorAgain() public {
        _certify(sarrafA);
        _deposit(sarrafB, 50_000_000e6); // floor => $1M cap; sarrafA low
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + 1 days + 1);
            vm.prank(sarrafA);
            sarrafRegistry.evaluate();
        }
        assertFalse(sarrafRegistry.isCertified(sarrafA), "dropped after 3 lows");

        // 950k TWAB (>=90% of floor but < floor) must NOT re-certify: re-entry
        // needs the full floor, not the exit bar.
        _deposit(sarrafA, 850_000e6); // balance 950k
        vm.warp(block.timestamp + 7 days);
        vm.prank(sarrafA);
        sarrafRegistry.evaluate();
        assertFalse(sarrafRegistry.isCertified(sarrafA), "hysteresis: re-entry needs 100% of floor");

        _deposit(sarrafA, 50_000e6); // balance 1M
        vm.warp(block.timestamp + 7 days);
        vm.prank(sarrafA);
        sarrafRegistry.evaluate();
        assertTrue(sarrafRegistry.isCertified(sarrafA), "full floor re-certifies");
    }

    /// The low streak resets when certification drops, so a fresh
    /// certification gets a fresh 3-strike budget.
    function test_lowStreak_resetsAcrossCertificationCycles() public {
        _certify(sarrafA);
        _deposit(sarrafB, 50_000_000e6); // floor at cap
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + 1 days + 1);
            vm.prank(sarrafA);
            sarrafRegistry.evaluate();
        }
        assertFalse(sarrafRegistry.isCertified(sarrafA));

        _deposit(sarrafA, 900_000e6); // balance 1M => TWAB 1M after a window
        vm.warp(block.timestamp + 7 days);
        vm.prank(sarrafA);
        sarrafRegistry.evaluate();
        assertTrue(sarrafRegistry.isCertified(sarrafA));
        assertEq(sarrafRegistry.lowStreak(sarrafA), 0, "fresh certification, fresh streak");
    }

    function test_floor_roundsDownOnDivisionByFive() public {
        _deposit(sarrafA, 7); // 7 / 5 = 1
        assertEq(sarrafRegistry.floor(), 1);
    }

    /// TWAB can never exceed the maximum balance held during the window.
    function testFuzz_twab_neverExceedsPeakBalance(uint96 a, uint96 b, uint32 gap) public {
        uint256 amountA = bound(uint256(a), 1, 1e15);
        uint256 amountB = bound(uint256(b), 1, 1e15);
        uint256 dt = bound(uint256(gap), 1, 14 days);
        _deposit(sarrafA, amountA);
        vm.warp(block.timestamp + dt);
        _deposit(sarrafA, amountB);
        vm.warp(block.timestamp + bound(uint256(gap) / 3, 1, 7 days));

        uint256 twab = sarrafRegistry.twabOf(sarrafA);
        assertLe(twab, amountA + amountB, "TWAB bounded by peak balance");
    }
}
