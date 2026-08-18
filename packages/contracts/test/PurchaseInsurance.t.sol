// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArmBase} from "./ArmBase.sol";
import {PurchaseInsurance, IIou1155} from "../src/PurchaseInsurance.sol";

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
    /// Hash of an off-chain evidence bundle. Only the HASH is ever on-chain.
    bytes32 internal constant EV1 = keccak256("buyer bundle: order + chat + non-delivery");

    function setUp() public override {
        super.setUp();
        _certify(sarrafA);
        _certify(sarrafB);

        shopA = makeAddr("shopA");
        buyer = makeAddr("buyer");
        maintainer = makeAddr("maintainer");
        adjudicator = makeAddr("adjudicator");

        ins = new PurchaseInsurance(
            IIou1155(address(iou)), sarrafRegistry, maintainer, adjudicator
        );
    }

    // ------------------------------------------------------------- helpers

    /// A sarraf posts a bond in their OWN paper -- exactly how a shop owner
    /// funds it in practice: local currency across the counter, IOU issued.
    function _registerShop(address sarraf, address shop, uint256 bond, uint32 trustBps) internal {
        _giveIou(sarraf, sarraf, bond);
        vm.startPrank(sarraf);
        iou.setApprovalForAll(address(ins), true);
        ins.registerShop(shop, bond, trustBps);
        vm.stopPrank();
    }

    /// Mint `to` some of `sarraf`'s tranche, fully backed.
    function _giveIou(address sarraf, address to, uint256 amount) internal {
        if (!registry.isMember(to)) _addMember(sarraf, to);
        _issueBacked(sarraf, to, amount);
    }

    /// vm.prank affects only the NEXT call, so the root must be read before it.
    function _rule(uint256 id, bool upheld) internal {
        bytes32 root = ins.evidenceRootOf(id);
        vm.prank(adjudicator);
        ins.ruleClaim(id, upheld, root);
    }

    function _purchase(address shop, uint256 amount) internal returns (uint256 id) {
        address sarraf = ins.sarrafOf(shop);
        uint256 premium = (amount * 90) / 10_000;
        _giveIou(sarraf, shop, premium);
        vm.startPrank(shop);
        iou.setApprovalForAll(address(ins), true);
        id = ins.recordPurchase(buyer, amount);
        vm.stopPrank();
    }

    function _fundBackstop(uint256 amount) internal {
        _fundBackstopFor(sarrafA, amount);
    }

    function _fundBackstopFor(address sarraf, uint256 amount) internal {
        _giveIou(sarraf, maintainer, amount);
        vm.startPrank(maintainer);
        iou.setApprovalForAll(address(ins), true);
        ins.fundMaintainer(_id(sarraf), amount);
        vm.stopPrank();
    }

    // ------------------------------------------------- 1. shops and bonds

    function test_registerShop_bondHeldAndCapsDerived() public {
        _registerShop(sarrafA, shopA, BOND, 10_000); // trust 1.0x

        assertEq(ins.bondOf(shopA), BOND, "bond escrowed");
        assertEq(iou.balanceOf(address(ins), _id(sarrafA)), BOND, "USDT actually held by the contract");
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
        uint256 buyerBefore = iou.balanceOf(buyer, _id(sarrafA));

        _purchase(shopA, PURCHASE);

        assertEq(iou.balanceOf(buyer, _id(sarrafA)), buyerBefore, "buyer pays no premium");
        assertEq(iou.balanceOf(shopA, _id(sarrafA)), 0, "seller paid the premium");
        assertEq(iou.balanceOf(address(ins), _id(sarrafA)), BOND + PREMIUM, "premium held with the bond");
    }

    function test_recordPurchase_splitsPremium5050_bothUnearned() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _purchase(shopA, PURCHASE);

        assertEq(ins.unearnedOf(sarrafA), PREMIUM / 2, "sarraf layer half, unearned");
        assertEq(ins.unearnedMaintainerOf(_id(sarrafA)), PREMIUM / 2, "maintainer half, unearned");
        assertEq(ins.earnedOf(sarrafA), 0, "nothing earned during coverage");
        assertEq(ins.earnedMaintainerOf(_id(sarrafA)), 0, "nothing earned during coverage");
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
        assertEq(ins.earnedMaintainerOf(_id(sarrafA)), PREMIUM / 2, "maintainer half earned");
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
        ins.fileClaim(id, EV1);
    }

    // ------------------------------------- 4. claims, waterfall, recusal

    function test_fileClaim_afterWindow_reverts() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);

        vm.warp(block.timestamp + 120 days + 1);
        vm.prank(buyer);
        vm.expectRevert(bytes("PI: coverage expired"));
        ins.fileClaim(id, EV1);
    }

    function test_ruleClaim_earningSarrafIsRecused() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id, EV1);

        // The sarraf who earns the premium on this sale may not rule on it.
        bytes32 root1 = ins.evidenceRootOf(id);
        vm.prank(sarrafA);
        vm.expectRevert(bytes("PI: recused"));
        ins.ruleClaim(id, true, root1);
    }

    function test_ruleClaim_onlyAdjudicator_reverts() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id, EV1);

        bytes32 root2 = ins.evidenceRootOf(id);

        vm.prank(outsider);
        vm.expectRevert(bytes("PI: not adjudicator"));
        ins.ruleClaim(id, true, root2);
    }

    /// Loss smaller than the bond: the shop alone absorbs it.
    function test_upheldClaim_paidFromBondFirst() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id, EV1);

        uint256 sarrafLayerBefore = ins.unearnedOf(sarrafA);

        _rule(id, true);

        assertEq(iou.balanceOf(buyer, _id(sarrafA)), PURCHASE, "buyer refunded in full");
        assertEq(ins.bondOf(shopA), BOND - PURCHASE, "bond slashed first");
        assertEq(ins.unearnedOf(sarrafA), sarrafLayerBefore, "sarraf layer untouched");
        assertEq(ins.earnedMaintainerOf(_id(sarrafA)), 0, "maintainer untouched");
    }

    /// Loss exceeding the bond cascades: bond -> the issuing sarraf's own
    /// layer -> the maintainer backstop, in that order.
    function test_upheldClaim_cascadesBondThenSarrafThenMaintainer() public {
        // The senior layer is a BASKET keyed by tranche: another sarraf's
        // premiums sit in THEIR paper and cannot pay this claim.
        address shopB = makeAddr("shopB");
        _registerShop(sarrafB, shopB, 10_000e6, 10_000);
        _purchase(shopB, 1_000e6);
        assertEq(ins.unearnedMaintainerOf(_id(sarrafB)), 4.5e6, "B's premiums land in B's tranche");
        _fundBackstopFor(sarrafA, 10e6); // capitalise THIS tranche

        // A thin bond with graduated trust: the shop may invoice beyond it.
        _registerShop(sarrafA, shopA, 1e6, 20_000); // 2x => max invoice 2e6
        uint256 loss = 1.2e6;
        uint256 id = _purchase(shopA, loss); // premium 10_800 -> 5_400 each layer

        uint256 seniorEarnedBefore = ins.earnedMaintainerOf(_id(sarrafA));
        vm.prank(buyer);
        ins.fileClaim(id, EV1);
        _rule(id, true);

        assertEq(iou.balanceOf(buyer, _id(sarrafA)), loss, "buyer made whole");
        assertEq(ins.bondOf(shopA), 0, "1. bond wiped out first");
        assertEq(ins.unearnedOf(sarrafA), 0, "2. issuing sarraf's layer drained second");
        // bond 1e6 + sarraf 5_400 absorbed first; the senior layer covers the
        // rest, unearned before earned.
        assertEq(ins.unearnedMaintainerOf(_id(sarrafA)), 0, "3a. senior unearned drained");
        assertEq(
            seniorEarnedBefore - ins.earnedMaintainerOf(_id(sarrafA)),
            loss - 1e6 - 5_400 - 5_400,
            "3b. senior earned covered only the true remainder"
        );
        assertEq(ins.unearnedOf(sarrafB), 4.5e6, "a careful sarraf's layer is never touched");
        assertEq(
            ins.unearnedMaintainerOf(_id(sarrafB)),
            4.5e6,
            "nor is their tranche of the senior basket"
        );
    }

    /// A loss beyond every layer cannot be silently half-paid: it reverts, and
    /// the claim stays open until the backstop is capitalised.
    function test_upheldClaim_beyondAllLayers_revertsUntilBackstopFunded() public {
        _registerShop(sarrafA, shopA, 100e6, 100_000); // 10x => 1_000e6 invoice
        uint256 loss = 1_000e6;
        uint256 id = _purchase(shopA, loss);

        vm.prank(buyer);
        ins.fileClaim(id, EV1);
        bytes32 root3 = ins.evidenceRootOf(id);
        vm.prank(adjudicator);
        vm.expectRevert(bytes("PI: fund insolvent"));
        ins.ruleClaim(id, true, root3);

        // The maintainer capitalises the senior layer, then the same claim pays.
        uint256 topUp = 1_000e6;
        _fundBackstopFor(sarrafA, topUp);

        _rule(id, true);
        assertEq(iou.balanceOf(buyer, _id(sarrafA)), loss, "buyer made whole once the backstop has capital");
    }

    function test_rejectedClaim_paysNothingAndReleasesCoverage() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id, EV1);

        _rule(id, false);

        assertEq(iou.balanceOf(buyer, _id(sarrafA)), 0, "no refund on a rejected claim");
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

        uint256 before = iou.balanceOf(sarrafA, _id(sarrafA));
        vm.prank(sarrafA);
        ins.withdraw(PREMIUM / 2);

        assertEq(iou.balanceOf(sarrafA, _id(sarrafA)) - before, PREMIUM / 2, "profit paid out");
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
            + ins.unearnedMaintainerOf(_id(sarrafA)) + ins.earnedMaintainerOf(_id(sarrafA));
        assertGe(iou.balanceOf(address(ins), _id(sarrafA)), owed, stage);
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
        ins.fileClaim(id2, EV1);
        _rule(id2, true);
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
        // Ceiling must exceed the fuzz range: this test is about premium
        // arithmetic, not about the invoice cap (which has its own test).
        _registerShop(sarrafA, shopA, 10_000e6, 10_000);
        _purchase(shopA, amount);

        uint256 premium = (amount * 90) / 10_000;
        assertEq(
            ins.unearnedOf(sarrafA) + ins.unearnedMaintainerOf(_id(sarrafA)),
            premium,
            "no wei created or lost in the 50/50 split"
        );
    }

    // -------------------------------------------- 7. velocity (sales/day)

    function test_dailyVolume_capBlocksBeyondLimit() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        vm.prank(sarrafA);
        ins.setDailyVolumeCap(shopA, 1_500e6);

        _purchase(shopA, 1_000e6); // ok: 1000 <= 1500
        uint256 premium = (600e6 * 90) / 10_000;
        usdt.mint(shopA, premium);
        vm.startPrank(shopA);
        usdt.approve(address(ins), premium);
        vm.expectRevert(bytes("PI: over daily cap"));
        ins.recordPurchase(buyer, 600e6); // 1000 + 600 > 1500
        vm.stopPrank();
    }

    function test_dailyVolume_rollsOverNextDay() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        vm.prank(sarrafA);
        ins.setDailyVolumeCap(shopA, 1_500e6);
        _purchase(shopA, 1_000e6);

        vm.warp(block.timestamp + 1 days);
        _purchase(shopA, 1_000e6); // fresh window
        assertEq(ins.soldTodayOf(shopA), 1_000e6, "counter reset with the new day");
    }

    function test_dailyVolume_zeroCapMeansUnlimited() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _purchase(shopA, 1_000e6);
        _purchase(shopA, 1_000e6);
        assertEq(ins.soldTodayOf(shopA), 2_000e6, "no cap set => not enforced");
    }

    function test_setDailyVolumeCap_onlyUnderwritingSarraf_reverts() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        vm.prank(sarrafB);
        vm.expectRevert(bytes("PI: not the underwriter"));
        ins.setDailyVolumeCap(shopA, 1e6);
    }

    // ------------------------------------------- 8. bond top-up / release

    function test_topUpBond_raisesExposureCeiling() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _giveIou(sarrafA, sarrafA, BOND);
        vm.prank(sarrafA);
        ins.topUpBond(shopA, BOND);

        assertEq(ins.bondOf(shopA), BOND * 2, "bond grew");
        assertEq(ins.maxExposure(shopA), BOND * 2, "ceiling follows the bond");
    }

    function test_topUpBond_anyoneMayFundIt() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        // The shop itself tops up its own bond, in its sarraf's paper.
        _giveIou(sarrafA, shopA, 500e6);
        vm.startPrank(shopA);
        iou.setApprovalForAll(address(ins), true);
        ins.topUpBond(shopA, 500e6);
        vm.stopPrank();
        assertEq(ins.bondOf(shopA), BOND + 500e6);
    }

    function test_releaseBond_blockedWhileCoverageIsLive() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _purchase(shopA, PURCHASE); // live exposure on this shop

        vm.prank(sarrafA);
        vm.expectRevert(bytes("PI: bond locked"));
        ins.releaseBond(shopA, 1);
    }

    function test_releaseBond_allowedOnceAllCoverageClosed() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.confirmReceipt(id);

        uint256 before = iou.balanceOf(sarrafA, _id(sarrafA));
        vm.prank(sarrafA);
        ins.releaseBond(shopA, BOND);

        assertEq(iou.balanceOf(sarrafA, _id(sarrafA)) - before, BOND, "bond returned to the underwriter");
        assertEq(ins.bondOf(shopA), 0);
    }

    function test_releaseBond_onlyUnderwritingSarraf_reverts() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        vm.prank(sarrafB);
        vm.expectRevert(bytes("PI: not the underwriter"));
        ins.releaseBond(shopA, 1);
    }

    // ------------------------------- 9. trust graduation and discipline

    function test_setTrust_raisesCeilingWithoutMoreBond() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        vm.prank(sarrafA);
        ins.setTrust(shopA, 30_000); // graduated after clean history
        assertEq(ins.maxExposure(shopA), BOND * 3, "trust alone lifts the ceiling");
    }

    function test_upheldClaim_cutsTrustBackToBaseline() public {
        _registerShop(sarrafA, shopA, BOND, 30_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id, EV1);
        _rule(id, true);

        assertEq(ins.trustBpsOf(shopA), 10_000, "a proven non-delivery resets trust to 1.0x");
    }

    function test_rejectedClaim_leavesTrustIntact() public {
        _registerShop(sarrafA, shopA, BOND, 30_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id, EV1);
        _rule(id, false);

        assertEq(ins.trustBpsOf(shopA), 30_000, "an unproven claim is not punishment");
    }

    // ---------------------------------------- 11. sarraf-level discipline

    /// A loss that only the shop's bond absorbs is not the sarraf's failure.
    function test_lossWithinBond_recordsNoStrike() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id, EV1);
        _rule(id, true);

        assertEq(ins.strikesOf(sarrafA), 0, "bond covered it: underwriting held");
    }

    /// A loss that pierces the bond and reaches the sarraf's own layer IS.
    function test_lossPiercingBond_recordsStrikeAgainstTheSarraf() public {
        _fundBackstop(10e6); // senior layer capitalised so the claim can pay
        _registerShop(sarrafA, shopA, 1e6, 20_000); // thin bond, graduated trust
        uint256 id = _purchase(shopA, 1.2e6);
        vm.prank(buyer);
        ins.fileClaim(id, EV1);
        _rule(id, true);

        assertEq(ins.strikesOf(sarrafA), 1, "bad underwriting is recorded against the sarraf");
    }

    function test_penalizeSarraf_movesEarnedToTheMaintainerLayer() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.confirmReceipt(id); // sarrafA earns 4.5e6

        uint256 maintainerBefore = ins.earnedMaintainerOf(_id(sarrafA));
        vm.prank(maintainer);
        ins.penalizeSarraf(sarrafA, 1e6);

        assertEq(ins.earnedOf(sarrafA), PREMIUM / 2 - 1e6, "penalty taken from earned premiums");
        assertEq(ins.earnedMaintainerOf(_id(sarrafA)), maintainerBefore + 1e6, "and it funds the backstop");
    }

    function test_penalizeSarraf_onlyMaintainer_reverts() public {
        vm.prank(adjudicator);
        vm.expectRevert(bytes("PI: not maintainer"));
        ins.penalizeSarraf(sarrafA, 1);
    }

    function test_penalizeSarraf_cannotExceedEarned_reverts() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _purchase(shopA, PURCHASE); // unearned only

        vm.prank(maintainer);
        vm.expectRevert(bytes("PI: over earned"));
        ins.penalizeSarraf(sarrafA, 1);
    }

    // ------------------------------ 12. provable purchases (IOU settlement)

    /// Give `buyer` spendable IOU on sarrafA's tranche and let the insurance
    /// contract move it on their behalf.
    function _fundBuyerWithIou(uint256 amount) internal {
        _giveIou(sarrafA, buyer, amount);
        vm.prank(buyer);
        iou.setApprovalForAll(address(ins), true);
    }

    function _approveShopPremium(address shop, uint256 amount) internal {
        address sarraf = ins.sarrafOf(shop);
        _giveIou(sarraf, shop, (amount * 90) / 10_000);
        vm.prank(shop);
        iou.setApprovalForAll(address(ins), true);
    }

    function test_payShop_movesIouAndRecordsTheSamePurchase() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _fundBuyerWithIou(5_000e6);
        _approveShopPremium(shopA, PURCHASE);

        uint256 id = _id(sarrafA);
        uint256 buyerBefore = iou.balanceOf(buyer, id);

        vm.prank(buyer);
        uint256 purchaseId = ins.payShop(shopA, PURCHASE);

        assertEq(iou.balanceOf(buyer, id), buyerBefore - PURCHASE, "buyer actually paid");
        assertEq(iou.balanceOf(shopA, id), PURCHASE, "shop actually received the money");

        PurchaseInsurance.Purchase memory p = ins.purchaseOf(purchaseId);
        assertEq(p.buyer, buyer, "buyer is msg.sender -- cannot be forged");
        assertEq(p.amount, PURCHASE, "covered amount == the amount that moved");
        assertEq(ins.outstandingExposureOf(sarrafA), PURCHASE, "coverage opened atomically");
    }

    function test_payShop_coversExactlyWhatWasTransferred() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _fundBuyerWithIou(5_000e6);
        _approveShopPremium(shopA, PURCHASE);

        vm.prank(buyer);
        uint256 purchaseId = ins.payShop(shopA, PURCHASE);

        // The buyer can claim on it, and is refunded the amount they truly sent.
        uint256 afterPaying = iou.balanceOf(buyer, _id(sarrafA));
        vm.prank(buyer);
        ins.fileClaim(purchaseId, EV1);
        _rule(purchaseId, true);
        assertEq(
            iou.balanceOf(buyer, _id(sarrafA)) - afterPaying,
            PURCHASE,
            "refunded exactly what was transferred, in the paper they paid with"
        );
    }

    function test_payShop_wrongTranche_isNotSpendable() public {
        // Buyer holds sarrafB's IOU but the shop is underwritten by sarrafA:
        // the payment must draw on the shop's own sarraf tranche.
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _addMember(sarrafB, buyer);
        _issueBacked(sarrafB, buyer, 5_000e6);
        vm.prank(buyer);
        iou.setApprovalForAll(address(ins), true);
        _approveShopPremium(shopA, PURCHASE);

        vm.prank(buyer);
        vm.expectRevert(bytes("IouToken: insufficient balance"));
        ins.payShop(shopA, PURCHASE);
    }

    function test_payShop_withoutApproval_reverts() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _addMember(sarrafA, buyer);
        _issueBacked(sarrafA, buyer, 5_000e6); // no setApprovalForAll
        _approveShopPremium(shopA, PURCHASE);

        vm.prank(buyer);
        vm.expectRevert(bytes("IouToken: not owner nor approved"));
        ins.payShop(shopA, PURCHASE);
    }

    function test_payShop_respectsInvoiceAndVelocityCaps() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        _fundBuyerWithIou(50_000e6);
        vm.prank(sarrafA);
        ins.setDailyVolumeCap(shopA, 1_500e6);
        _approveShopPremium(shopA, 1_000e6);

        vm.prank(buyer);
        ins.payShop(shopA, 1_000e6);

        _approveShopPremium(shopA, 600e6);
        vm.prank(buyer);
        vm.expectRevert(bytes("PI: over daily cap"));
        ins.payShop(shopA, 600e6);
    }

    // ------------------------------------------- 12. buyer-side strikes

    /// Card networks score cardholders, not only merchants. A buyer whose
    /// claims are repeatedly rejected is a signal in their own right.
    function test_rejectedClaim_recordsStrikeAgainstTheBuyer() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id, EV1);
        _rule(id, false);

        assertEq(ins.buyerStrikesOf(buyer), 1, "a rejected claim counts against the claimant");
    }

    function test_upheldClaim_leavesBuyerUnmarked() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id, EV1);
        _rule(id, true);

        assertEq(ins.buyerStrikesOf(buyer), 0, "a legitimate claim is never punished");
    }

    function test_buyerStrikes_accumulateAcrossPurchases() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        for (uint256 i; i < 3; ++i) {
            uint256 id = _purchase(shopA, PURCHASE);
            vm.prank(buyer);
            ins.fileClaim(id, EV1);
            _rule(id, false);
        }
        assertEq(ins.buyerStrikesOf(buyer), 3, "serial claimant is visible");
    }

    function test_buyerStrikes_areScopedToTheClaimant() public {
        address other = makeAddr("otherBuyer");
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id, EV1);
        _rule(id, false);

        assertEq(ins.buyerStrikesOf(other), 0, "one buyer's record never taints another");
    }

    // ------------------------------------------- 13. evidence and rulings

    /// A claim must arrive with evidence, and a ruling must state exactly which
    /// evidence it judged. Without that, "the adjudicator decided" is not
    /// reviewable by anyone afterwards.

    function _dispute() internal returns (uint256 id) {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        ins.fileClaim(id, EV1);
    }

    function test_fileClaim_requiresEvidence() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE);
        vm.prank(buyer);
        vm.expectRevert(bytes("PI: no evidence"));
        ins.fileClaim(id, bytes32(0));
    }

    function test_fileClaim_recordsEvidenceInTheRoot() public {
        uint256 id = _dispute();
        assertTrue(ins.evidenceRootOf(id) != bytes32(0), "root set from the buyer's bundle");
        assertEq(ins.evidenceCountOf(id), 1, "one bundle on record");
    }

    function test_ruleClaim_mustReferenceTheRootItJudged() public {
        uint256 id = _dispute();
        vm.prank(adjudicator);
        vm.expectRevert(bytes("PI: stale evidence"));
        ins.ruleClaim(id, true, keccak256("some other bundle"));
    }

    function test_ruleClaim_withCurrentRoot_succeeds() public {
        uint256 id = _dispute();
        _rule(id, true);
        assertEq(iou.balanceOf(buyer, _id(sarrafA)), PURCHASE, "upheld and paid");
    }

    /// The substitution attack this exists to stop: evidence lands after the
    /// adjudicator formed a view, so the ruling they submit no longer matches
    /// what is on record. It must fail rather than silently apply.
    function test_lateEvidence_invalidatesAnInFlightRuling() public {
        uint256 id = _dispute();
        bytes32 seen = ins.evidenceRootOf(id);

        vm.prank(shopA); // the shop rebuts
        ins.submitEvidence(id, keccak256("delivery photo + signature"));

        vm.prank(adjudicator);
        vm.expectRevert(bytes("PI: stale evidence"));
        ins.ruleClaim(id, true, seen);

        // Re-reading the record, the same ruling now goes through.
        _rule(id, true);
    }

    function test_submitEvidence_sellerAndBuyerOnly() public {
        uint256 id = _dispute();
        vm.prank(outsider);
        vm.expectRevert(bytes("PI: not a party"));
        ins.submitEvidence(id, keccak256("hearsay"));
    }

    function test_submitEvidence_onlyWhileDisputed() public {
        _registerShop(sarrafA, shopA, BOND, 10_000);
        uint256 id = _purchase(shopA, PURCHASE); // COVERED, not disputed
        vm.prank(buyer);
        vm.expectRevert(bytes("PI: not disputed"));
        ins.submitEvidence(id, keccak256("premature"));
    }

    function test_evidenceRoot_dependsOnOrderAndContent() public {
        uint256 id = _dispute();
        bytes32 before = ins.evidenceRootOf(id);
        vm.prank(shopA);
        ins.submitEvidence(id, keccak256("b"));
        assertTrue(ins.evidenceRootOf(id) != before, "root moves when evidence is added");
    }

    /// The earning sarraf is recused at this layer too, not only the old one.
    function test_ruleClaim_earningSarrafStillRecused_withEvidence() public {
        uint256 id = _dispute();
        bytes32 root4 = ins.evidenceRootOf(id);
        vm.prank(sarrafA);
        vm.expectRevert(bytes("PI: recused"));
        ins.ruleClaim(id, true, root4);
    }
}
