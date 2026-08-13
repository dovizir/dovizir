// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AcceptanceBase} from "./AcceptanceBase.sol";
import {IInsuranceFund} from "../src/interfaces/IDovizir.sol";

/// IInsuranceFund acceptance: 90 bps fee receipt with 50/50
/// overseeing/maintenance split bookkeeping, NoteVault-only payClaim
/// (IDovizir.sol; PROTOCOL.md §1).
contract InsuranceFundTest is AcceptanceBase {
    function setUp() public override {
        super.setUp();
        _certify(sarrafA);
        _addMember(sarrafA, memberA1);
    }

    /// Route a fee into the fund via the only M1 fee source: a redemption.
    function _generateFee(uint256 redeemAmount) internal returns (uint256 fee) {
        _issueBacked(sarrafA, memberA1, redeemAmount);
        vm.prank(memberA1);
        pool.redeem(sarrafA, redeemAmount);
        fee = _fee(redeemAmount);
    }

    /// IDovizir.sol: fee accounting splits 50/50 into overseeingShare and
    /// maintenanceShare (bookkeeping only in M1).
    function test_feeReceipt_evenFee_splitsFiftyFifty() public {
        uint256 fee = _generateFee(20_000e6); // fee = 180e6, even
        assertEq(fee, 180e6, "fixture sanity");
        assertEq(fund.overseeingShare(), 90e6, "half to overseeing");
        assertEq(fund.maintenanceShare(), 90e6, "half to maintenance");
        assertEq(fund.totalReserves(), 180e6);
    }

    /// FROZEN ROUNDING RULE (README.md): for an odd-wei fee, maintenanceShare
    /// takes the rounded-DOWN half (fee/2); overseeingShare takes the
    /// remainder (fee - fee/2), i.e. the extra wei.
    function test_feeReceipt_oddFee_maintenanceRoundsDown() public {
        uint256 fee = _generateFee(1_000); // fee = 1_000*90/10_000 = 9 (odd)
        assertEq(fee, 9, "fixture sanity: odd fee");
        assertEq(fund.maintenanceShare(), 4, "maintenance = fee/2 rounded down");
        assertEq(fund.overseeingShare(), 5, "overseeing = fee - fee/2 (extra wei)");
        assertEq(fund.totalReserves(), 9);
    }

    /// IDovizir.sol: totalReserves == overseeingShare + maintenanceShare
    /// across multiple receipts (mix of odd and even fees).
    function test_totalReserves_equalsShareSum_acrossMultipleFees() public {
        uint256 f1 = _generateFee(20_000e6); // even
        uint256 f2 = _generateFee(1_000); // odd (9)
        uint256 f3 = _generateFee(3_000); // odd (27)
        assertEq(fund.totalReserves(), f1 + f2 + f3, "reserves accumulate every fee");
        assertEq(
            fund.totalReserves(),
            fund.overseeingShare() + fund.maintenanceShare(),
            "shares partition the reserves exactly"
        );
    }

    /// IDovizir.sol: FeeReceived(amount) emitted by the fund on fee receipt.
    function test_feeReceived_emittedOnRedemptionFee() public {
        _issueBacked(sarrafA, memberA1, 20_000e6);
        vm.expectEmit(false, false, false, true, address(fund));
        emit IInsuranceFund.FeeReceived(_fee(20_000e6));
        vm.prank(memberA1);
        pool.redeem(sarrafA, 20_000e6);
    }

    /// IDovizir.sol: "Pays a double-spend victim (NoteVault-only caller)" —
    /// every other caller reverts and reserves are untouched.
    function test_payClaim_revertsForNonVaultCallers() public {
        uint256 reserves = _generateFee(100_000e6);

        vm.prank(attacker);
        vm.expectRevert();
        fund.payClaim(attacker, 1);

        vm.prank(address(pool));
        vm.expectRevert();
        fund.payClaim(recipient1, 1);

        vm.prank(sarrafA);
        vm.expectRevert();
        fund.payClaim(sarrafA, 1);

        assertEq(fund.totalReserves(), reserves, "reserves untouched by unauthorized claims");
    }

    /// IDovizir.sol: the NoteVault CAN pay a claim — victim receives USDT,
    /// reserves drop by the claim, and the share split still partitions the
    /// remaining reserves.
    function test_payClaim_byNoteVault_paysVictimUsdt_keepsShareSumConsistent() public {
        uint256 reserves = _generateFee(1_000_000e6); // fee = 9_000e6
        assertEq(reserves, 9_000e6, "fixture sanity");

        vm.prank(address(vault));
        fund.payClaim(recipient2, 4_000e6);

        assertEq(usdt.balanceOf(recipient2), 4_000e6, "victim paid in USDT");
        assertEq(fund.totalReserves(), 5_000e6, "reserves reduced by the claim");
        assertEq(
            fund.totalReserves(),
            fund.overseeingShare() + fund.maintenanceShare(),
            "share sum tracks reserves after claims"
        );
    }
}
