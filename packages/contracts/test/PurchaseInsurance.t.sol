// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArmBase} from "./ArmBase.sol";
import {PurchaseInsurance} from "../src/PurchaseInsurance.sol";
import {IUsdt} from "../src/ReservePool.sol";

/// Purchase-insurance mechanism per docs/design/purchase-insurance.md:
/// shop bonds, 0.9% seller premium split 50/50, unearned-until-window,
/// sequential loss waterfall (bond -> sarraf layer -> maintainer), recusal,
/// and withdrawal capped by a solvency cushion.
contract PurchaseInsuranceTest is ArmBase {
    PurchaseInsurance internal ins;

    address internal shopA; //   shop registered by sarrafA
    address internal buyer;
    address internal maintainer;
    address internal adjudicator; // overseeing body (not the earning sarraf)

    uint256 internal constant BOND = 10_000e6;
    uint256 internal constant PURCHASE = 1_000e6;
    /// 0.9% of 1_000e6 == 9e6, split 4.5e6 / 4.5e6.
    uint256 internal constant PREMIUM = 9e6;

    function setUp() public override {
        super.setUp();
        _certify(sarrafA);
        _certify(sarrafB);

        shopA = makeAddr("shopA");
        buyer = makeAddr("buyer");
        maintainer = makeAddr("maintainer");
        adjudicator = makeAddr("adjudicator");

        ins = new PurchaseInsurance(
            IUsdt(address(usdt)), sarrafRegistry, maintainer, adjudicator
        );
    }

    // ------------------------------------------------------------- helpers

    function _registerShop(address sarraf, address shop, uint256 bond, uint32 trustBps) internal {
        usdt.mint(sarraf, bond);
        vm.startPrank(sarraf);
        usdt.approve(address(ins), bond);
        ins.registerShop(shop, bond, trustBps);
        vm.stopPrank();
    }

    function _purchase(address shop, uint256 amount) internal returns (uint256 id) {
        uint256 premium = (amount * 90) / 10_000;
        usdt.mint(shop, premium);
        vm.startPrank(shop);
        usdt.approve(address(ins), premium);
        id = ins.recordPurchase(buyer, amount);
        vm.stopPrank();
    }

    // ------------------------------------------------- 1. shops and bonds

    function test_registerShop_bondHeldAndCapsDerived() public {
        _registerShop(sarrafA, shopA, BOND, 10_000); // trust 1.0x

        assertEq(ins.bondOf(shopA), BOND, "bond escrowed");
        assertEq(usdt.balanceOf(address(ins)), BOND, "USDT actually held by the contract");
        assertEq(ins.sarrafOf(shopA), sarrafA, "shop attributed to its sarraf");
        assertEq(ins.maxExposure(shopA), BOND, "trust 1.0x => exposure == bond");
    }

    function test_maxExposure_scalesWithTrustMultiplier() public {
        _registerShop(sarrafA, shopA, BOND, 25_000); // 2.5x graduation
        assertEq(ins.maxExposure(shopA), (BOND * 25_000) / 10_000);
    }

    function test_registerShop_onlyCertifiedSarraf_reverts() public {
        address notSarraf = makeAddr("notSarraf");
        usdt.mint(notSarraf, BOND);
        vm.startPrank(notSarraf);
        usdt.approve(address(ins), BOND);
        vm.expectRevert(bytes("PI: not certified"));
        ins.registerShop(shopA, BOND, 10_000);
        vm.stopPrank();
    }

    function test_registerShop_zeroBond_reverts() public {
        vm.prank(sarrafA);
        vm.expectRevert(bytes("PI: zero bond"));
        ins.registerShop(shopA, 0, 10_000);
    }

    // ------------------------------------------ 2. purchases and premiums

    function test_recordPurchase_chargesSellerNotBuyer() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 buyerBefore = usdt.balanceOf(buyer);

        _purchase(shopA, PURCHASE);

        assertEq(usdt.balanceOf(buyer), buyerBefore, "buyer pays no premium");
        assertEq(usdt.balanceOf(shopA), 0, "seller paid the premium");
        assertEq(usdt.balanceOf(address(ins)), BOND + PREMIUM, "premium held with the bond");
    }

    function test_recordPurchase_splitsPremium5050_bothUnearned() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _purchase(shopA, PURCHASE);

        assertEq(ins.unearnedOf(sarrafA), PREMIUM / 2, "sarraf layer half, unearned");
        assertEq(ins.unearnedMaintainer(), PREMIUM / 2, "maintainer half, unearned");
        assertEq(ins.earnedOf(sarrafA), 0, "nothing earned during coverage");
        assertEq(ins.earnedMaintainer(), 0, "nothing earned during coverage");
    }

    function test_recordPurchase_perSarrafLayersAreSeparate() public {
        address shopB = makeAddr("shopB");
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _registerShop(sarrafB, shopB, BOND, 10_000);

        _purchase(shopA, PURCHASE);

        assertEq(ins.unearnedOf(sarrafA), PREMIUM / 2, "earning sarraf credited");
        assertEq(ins.unearnedOf(sarrafB), 0, "other sarraf's layer untouched -- not pooled");
    }

    function test_recordPurchase_overMaxInvoice_reverts() public {
        _registerShop(sarrafA, shopA, BOND, 10_000); // maxExposure == BOND
        uint256 tooBig = BOND + 1;
        uint256 premium = (tooBig * 90) / 10_000;
        usdt.mint(shopA, premium);
        vm.startPrank(shopA);
        usdt.approve(address(ins), premium);
        vm.expectRevert(bytes("PI: over max invoice"));
        ins.recordPurchase(buyer, tooBig);
        vm.stopPrank();
    }

    function test_recordPurchase_unregisteredShop_reverts() public {
        address ghost = makeAddr("ghost");
        vm.prank(ghost);
        vm.expectRevert(bytes("PI: shop not registered"));
        ins.recordPurchase(buyer, PURCHASE);
    }

    function test_recordPurchase_tracksOutstandingExposure() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _purchase(shopA, PURCHASE);
        assertEq(
            ins.outstandingExposureOf(sarrafA), PURCHASE, "covered purchase is live exposure"
        );
    }

    // ---------------------------------------- 3. earning the premium

    function test_earn_afterWindow_movesUnearnedToEarned() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);

        vm.warp(block.timestamp + 120 days + 1);
        ins.earn(id);

        assertEq(ins.unearnedOf(sarrafA), 0, "no longer unearned");
        assertEq(ins.earnedOf(sarrafA), PREMIUM / 2, "sarraf half earned");
        assertEq(ins.earnedMaintainer(), PREMIUM / 2, "maintainer half earned");
        assertEq(ins.outstandingExposureOf(sarrafA), 0, "exposure released");
    }

    function test_earn_beforeWindow_reverts() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);

        vm.warp(block.timestamp + 119 days);
        vm.expectRevert(bytes("PI: still covered"));
        ins.earn(id);
    }

    function test_confirmReceipt_earnsImmediately() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);

        vm.prank(buyer);
        ins.confirmReceipt(id);

        assertEq(ins.earnedOf(sarrafA), PREMIUM / 2, "buyer confirmation ends coverage early");
        assertEq(ins.outstandingExposureOf(sarrafA), 0, "exposure released on confirmation");
    }

    function test_confirmReceipt_onlyBuyer_reverts() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);

        vm.prank(shopA);
        vm.expectRevert(bytes("PI: not buyer"));
        ins.confirmReceipt(id);
    }

    function test_confirmedPurchase_cannotBeClaimed() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.confirmReceipt(id);

        vm.prank(buyer);
        vm.expectRevert(bytes("PI: not covered"));
        ins.fileClaim(id);
    }

    // ------------------------------------- 4. claims, waterfall, recusal

    function test_fileClaim_afterWindow_reverts() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);

        vm.warp(block.timestamp + 120 days + 1);
        vm.prank(buyer);
        vm.expectRevert(bytes("PI: coverage expired"));
        ins.fileClaim(id);
    }

    function test_ruleClaim_earningSarrafIsRecused() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id);

        // The sarraf who earns the premium on this sale may not rule on it.
        vm.prank(sarrafA);
        vm.expectRevert(bytes("PI: recused"));
        ins.ruleClaim(id, true);
    }

    function test_ruleClaim_onlyAdjudicator_reverts() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id);

        vm.prank(outsider);
        vm.expectRevert(bytes("PI: not adjudicator"));
        ins.ruleClaim(id, true);
    }

    /// Loss smaller than the bond: the shop alone absorbs it.
    function test_upheldClaim_paidFromBondFirst() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id);

        uint256 sarrafLayerBefore = ins.unearnedOf(sarrafA);

        vm.prank(adjudicator);
        ins.ruleClaim(id, true);

        assertEq(usdt.balanceOf(buyer), PURCHASE, "buyer refunded in full");
        assertEq(ins.bondOf(shopA), BOND - PURCHASE, "bond slashed first");
        assertEq(ins.unearnedOf(sarrafA), sarrafLayerBefore, "sarraf layer untouched");
        assertEq(ins.earnedMaintainer(), 0, "maintainer untouched");
    }

    /// Loss exceeding the bond cascades: bond -> the issuing sarraf's own
    /// layer -> the maintainer backstop, in that order.
    function test_upheldClaim_cascadesBondThenSarrafThenMaintainer() public {
        // Give the senior layer depth from an unrelated sarraf's premiums,
        // proving the maintainer layer is shared while sarraf layers are not.
        address shopB = makeAddr("shopB");
        _registerShop(sarrafB, shopB, 10_000e6, 10_000);
        _purchase(shopB, 1_000e6); // maintainer unearned += 4.5e6

        // A thin bond with graduated trust: the shop may invoice beyond it.
        _registerShop(sarrafA, shopA, 1e6, 20_000); // 2x => max invoice 2e6
        uint256 loss = 1.2e6;
        uint256 id = _purchase(shopA, loss); // premium 10_800 -> 5_400 each layer

        uint256 maintainerBefore = ins.unearnedMaintainer();
        vm.prank(buyer);
        ins.fileClaim(id);
        vm.prank(adjudicator);
        ins.ruleClaim(id, true);

        assertEq(usdt.balanceOf(buyer), loss, "buyer made whole");
        assertEq(ins.bondOf(shopA), 0, "1. bond wiped out first");
        assertEq(ins.unearnedOf(sarrafA), 0, "2. issuing sarraf's layer drained second");
        // bond 1e6 + sarraf 5_400 = 1_005_400; the senior layer covers the rest.
        assertEq(
            ins.unearnedMaintainer(),
            maintainerBefore - (loss - 1e6 - 5_400),
            "3. maintainer absorbed only the senior remainder"
        );
        assertEq(ins.unearnedOf(sarrafB), 4.5e6, "a careful sarraf's layer is never touched");
    }

    /// A loss beyond every layer cannot be silently half-paid: it reverts, and
    /// the claim stays open until the backstop is capitalised.
    function test_upheldClaim_beyondAllLayers_revertsUntilBackstopFunded() public {
        _registerShop(sarrafA, shopA, 100e6, 100_000); // 10x => 1_000e6 invoice
        uint256 loss = 1_000e6;
        uint256 id = _purchase(shopA, loss);

        vm.prank(buyer);
        ins.fileClaim(id);
        vm.prank(adjudicator);
        vm.expectRevert(bytes("PI: fund insolvent"));
        ins.ruleClaim(id, true);

        // The maintainer capitalises the senior layer, then the same claim pays.
        uint256 topUp = 1_000e6;
        usdt.mint(maintainer, topUp);
        vm.startPrank(maintainer);
        usdt.approve(address(ins), topUp);
        ins.fundMaintainer(topUp);
        vm.stopPrank();

        vm.prank(adjudicator);
        ins.ruleClaim(id, true);
        assertEq(usdt.balanceOf(buyer), loss, "buyer made whole once the backstop has capital");
    }

    function test_rejectedClaim_paysNothingAndReleasesCoverage() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id);

        vm.prank(adjudicator);
        ins.ruleClaim(id, false);

        assertEq(usdt.balanceOf(buyer), 0, "no refund on a rejected claim");
        assertEq(ins.bondOf(shopA), BOND, "bond intact");
        assertEq(ins.earnedOf(sarrafA), PREMIUM / 2, "premium earned once the dispute clears");
    }

    // ------------------------------------------ 5. withdrawal cushion

    function test_withdraw_blockedWhileExposureRequiresCushion() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.confirmReceipt(id); // earns 4.5e6, releases this purchase's exposure

        // A second, still-live purchase keeps exposure outstanding.
        _purchase(shopA, PURCHASE);
        assertEq(ins.outstandingExposureOf(sarrafA), PURCHASE, "live exposure");

        // cushion = 10% of 1_000e6 = 100e6 > earned 4.5e6 => nothing withdrawable.
        assertEq(ins.withdrawableOf(sarrafA), 0, "cushion exceeds earned surplus");
        vm.prank(sarrafA);
        vm.expectRevert(bytes("PI: over withdrawable"));
        ins.withdraw(1);
        assertEq(id, 1);
    }

    function test_withdraw_earnedSurplusAboveCushion() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.confirmReceipt(id);

        // No live exposure => the whole earned balance is withdrawable.
        assertEq(ins.outstandingExposureOf(sarrafA), 0);
        assertEq(ins.withdrawableOf(sarrafA), PREMIUM / 2, "earned with no exposure");

        uint256 before = usdt.balanceOf(sarrafA);
        vm.prank(sarrafA);
        ins.withdraw(PREMIUM / 2);

        assertEq(usdt.balanceOf(sarrafA) - before, PREMIUM / 2, "profit paid out");
        assertEq(ins.earnedOf(sarrafA), 0, "earned balance consumed");
    }

    function test_withdraw_cannotTouchUnearned() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _purchase(shopA, PURCHASE); // stays unearned inside the window

        assertEq(ins.earnedOf(sarrafA), 0);
        assertEq(ins.withdrawableOf(sarrafA), 0, "unearned premium is not profit");
        vm.prank(sarrafA);
        vm.expectRevert(bytes("PI: over withdrawable"));
        ins.withdraw(1);
    }

    // ------------------------------------------------------- 6. solvency

    /// The contract's USDT balance must always cover every claim on it:
    /// bonds + both layers' premium balances. Checked across the full
    /// lifecycle -- register, purchase, confirm, claim, payout, withdraw.
    function _assertBacked(string memory stage) internal view {
        uint256 owed = ins.bondOf(shopA) + ins.unearnedOf(sarrafA) + ins.earnedOf(sarrafA)
            + ins.unearnedMaintainer() + ins.earnedMaintainer();
        assertGe(usdt.balanceOf(address(ins)), owed, stage);
    }

    function test_invariant_contractAlwaysCoversItsObligations() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _assertBacked("after registration");

        uint256 id1 = _purchase(shopA, PURCHASE);
        _assertBacked("after purchase");

        vm.prank(buyer);
        ins.confirmReceipt(id1);
        _assertBacked("after confirmation");

        uint256 id2 = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id2);
        vm.prank(adjudicator);
        ins.ruleClaim(id2, true);
        _assertBacked("after an upheld claim paid out");

        uint256 w = ins.withdrawableOf(sarrafA);
        if (w > 0) {
            vm.prank(sarrafA);
            ins.withdraw(w);
        }
        _assertBacked("after withdrawal");
    }

    /// Premium is symmetric: what each layer holds equals what was charged.
    function testFuzz_premiumSplitConservesTheWholeFee(uint96 raw) public {
        uint256 amount = uint256(raw) % 5_000e6 + 1e6;
        _registerShop(sarrafA, shopA, 5_000e6, 10_000);
        _purchase(shopA, amount);

        uint256 premium = (amount * 90) / 10_000;
        assertEq(
            ins.unearnedOf(sarrafA) + ins.unearnedMaintainer(),
            premium,
            "no wei created or lost in the 50/50 split"
        );
    }
}
