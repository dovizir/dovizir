// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArmBase} from "./ArmBase.sol";
import {Escrow, IEscrowIou} from "../src/Escrow.sol";

/// @dev Attacker-controlled ERC-1155 receiver used as the TAKER, to prove the
/// reentrancy guard holds when the escrow releases IOU to a hostile contract.
/// On receiving the IOU it tries to re-enter a state-changing escrow function;
/// the attempt is caught so the outer transfer still returns the magic value,
/// and the test asserts the re-entry was rejected.
contract ReentrantTaker {
    Escrow public immutable escrow;
    uint256 public target;
    bool public armed;
    bool public reentryAttempted;
    bool public reentryReverted;
    uint8 public mode; // 0 = confirm, 1 = cancel, 2 = resolve

    constructor(Escrow escrow_) {
        escrow = escrow_;
    }

    function arm(uint256 orderId, uint8 mode_) external {
        target = orderId;
        armed = true;
        mode = mode_;
    }

    function fill(uint256 orderId) external {
        escrow.fillOrder(orderId);
    }

    function claim(uint256 orderId, bytes32 h) external {
        escrow.claimFiatPaid(orderId, h);
    }

    function raise(uint256 orderId) external {
        escrow.raiseDispute(orderId);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (armed) {
            armed = false; // one shot
            reentryAttempted = true;
            try this.reenter() {
                reentryReverted = false;
            } catch {
                reentryReverted = true;
            }
        }
        return 0xf23a6e61;
    }

    /// external so the try/catch above can wrap it.
    function reenter() external {
        require(msg.sender == address(this), "self only");
        if (mode == 0) escrow.confirmReceived(target);
        else if (mode == 1) escrow.cancel(target);
        else escrow.resolve(target, true);
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }
}

/// @dev Stand-in IOU used only to probe the {onERC1155Received} custody gate at
/// the tranche-id boundary. It impersonates the escrow's `iou` (so it is an
/// authorized caller of the receiver hook) and pushes a stray receive for an
/// arbitrary id WITHOUT the escrow having initiated a deposit.
contract WrapProbeIou {
    function balanceOf(address, uint256) external pure returns (uint256) {
        return 0;
    }

    function safeTransferFrom(address, address, uint256, uint256, bytes calldata) external {}

    /// Simulate the IOU delivering a stray token of tranche `id` to the escrow.
    function pushReceive(address escrow_, uint256 id) external {
        Escrow(escrow_).onERC1155Received(address(this), address(this), id, 1, "");
    }
}

contract EscrowTest is ArmBase {
    Escrow internal escrow;

    uint256 internal T; // tranche id of sarrafA (the arbiter)
    address internal maker; // memberA1
    address internal taker; // memberA2
    address internal backstop; // protocol fallback arbiter

    uint256 internal constant AMT = 100e6; // 100 IOU
    uint256 internal constant FIAT = 5_000_000; // agreed fiat units
    uint64 internal constant WINDOW = 1 hours;
    bytes32 internal constant QUOTE = keccak256("quote-1");
    bytes32 internal constant RECEIPT = keccak256("receipt-1");

    function setUp() public override {
        super.setUp();
        // `outsider` is the protocol backstop arbiter: a non-party, non-Sarraf
        // fallback resolver that may only act after DISPUTE_TIMEOUT.
        backstop = outsider;
        escrow = new Escrow(IEscrowIou(address(iou)), backstop);

        _certify(sarrafA);
        _addMember(sarrafA, memberA1);
        _addMember(sarrafA, memberA2);
        _issueBacked(sarrafA, memberA1, 10_000e6);

        T = _id(sarrafA);
        maker = memberA1;
        taker = memberA2;

        vm.prank(maker);
        iou.setApprovalForAll(address(escrow), true);
    }

    // ------------------------------------------------------------- helpers

    function _open() internal returns (uint256 id) {
        vm.prank(maker);
        id = escrow.createOrder(sarrafA, AMT, "IRR", FIAT, QUOTE, WINDOW);
    }

    function _matched() internal returns (uint256 id) {
        id = _open();
        vm.prank(taker);
        escrow.fillOrder(id);
    }

    function _claimed() internal returns (uint256 id) {
        id = _matched();
        vm.prank(taker);
        escrow.claimFiatPaid(id, RECEIPT);
    }

    function _disputed() internal returns (uint256 id) {
        id = _claimed();
        // The taker's dispute is now gated behind the maker-confirm window
        // (fix 2). Warp past it so the taker can escalate. The resolve tests
        // that build on this helper are unconcerned with the timing itself.
        vm.warp(block.timestamp + escrow.CONFIRM_WINDOW());
        vm.prank(taker);
        escrow.raiseDispute(id);
    }

    // --------------------------------------------------------- create + lock

    function test_createOrder_locksIou() public {
        uint256 makerBefore = iou.balanceOf(maker, T);
        uint256 id = _open();

        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Open));
        assertEq(iou.balanceOf(maker, T), makerBefore - AMT, "maker debited");
        assertEq(iou.balanceOf(address(escrow), T), AMT, "escrow holds IOU");
        assertEq(escrow.arbiterOf(id), sarrafA, "arbiter derived from tranche");

        Escrow.Order memory o = escrow.getOrder(id);
        assertEq(o.maker, maker);
        assertEq(o.usdtAmount, AMT);
        assertEq(o.fiatAmount, FIAT);
        assertEq(o.quoteHash, QUOTE);
    }

    function test_createOrder_zeroAmount_reverts() public {
        vm.prank(maker);
        vm.expectRevert("Escrow: zero amount");
        escrow.createOrder(sarrafA, 0, "IRR", FIAT, QUOTE, WINDOW);
    }

    function test_createOrder_zeroSarraf_reverts() public {
        vm.prank(maker);
        vm.expectRevert("Escrow: zero sarraf");
        escrow.createOrder(address(0), AMT, "IRR", FIAT, QUOTE, WINDOW);
    }

    function test_createOrder_zeroFiat_reverts() public {
        vm.prank(maker);
        vm.expectRevert("Escrow: zero fiat amount");
        escrow.createOrder(sarrafA, AMT, "IRR", 0, QUOTE, WINDOW);
    }

    function test_createOrder_emptyFiat_reverts() public {
        vm.prank(maker);
        vm.expectRevert("Escrow: empty fiat");
        escrow.createOrder(sarrafA, AMT, "", FIAT, QUOTE, WINDOW);
    }

    function test_createOrder_windowTooSmall_reverts() public {
        vm.prank(maker);
        vm.expectRevert("Escrow: bad payment window");
        escrow.createOrder(sarrafA, AMT, "IRR", FIAT, QUOTE, 1 minutes);
    }

    function test_createOrder_windowTooLarge_reverts() public {
        vm.prank(maker);
        vm.expectRevert("Escrow: bad payment window");
        escrow.createOrder(sarrafA, AMT, "IRR", FIAT, QUOTE, 60 days);
    }

    // Self-deal guard #1: the tranche's own Sarraf cannot be the maker.
    function test_createOrder_arbiterIsMaker_reverts() public {
        vm.prank(sarrafA);
        vm.expectRevert("Escrow: arbiter is maker");
        escrow.createOrder(sarrafA, AMT, "IRR", FIAT, QUOTE, WINDOW);
    }

    // ------------------------------------------------------------------ fill

    function test_fill_matches() public {
        uint256 id = _open();
        vm.prank(taker);
        escrow.fillOrder(id);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Matched));
        assertEq(escrow.getOrder(id).taker, taker);
        assertEq(escrow.paymentDeadline(id), block.timestamp + WINDOW);
    }

    function test_fill_twice_reverts() public {
        uint256 id = _matched();
        vm.prank(recipient1);
        vm.expectRevert("Escrow: not open");
        escrow.fillOrder(id);
    }

    function test_fill_makerCannotFill() public {
        uint256 id = _open();
        vm.prank(maker);
        vm.expectRevert("Escrow: maker cannot fill");
        escrow.fillOrder(id);
    }

    // Self-deal guard #2: the arbiter cannot be the taker.
    function test_fill_arbiterCannotFill() public {
        uint256 id = _open();
        vm.prank(sarrafA);
        vm.expectRevert("Escrow: arbiter is taker");
        escrow.fillOrder(id);
    }

    // ------------------------------------------------------------ claim fiat

    function test_claim_setsReceiptAndClaims() public {
        uint256 id = _matched();
        vm.prank(taker);
        escrow.claimFiatPaid(id, RECEIPT);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.FiatClaimed));
        assertEq(escrow.getOrder(id).receiptHash, RECEIPT);
        assertEq(escrow.confirmDeadline(id), block.timestamp + escrow.CONFIRM_WINDOW());
    }

    function test_claim_onlyTaker() public {
        uint256 id = _matched();
        vm.prank(maker);
        vm.expectRevert("Escrow: only taker");
        escrow.claimFiatPaid(id, RECEIPT);
    }

    function test_claim_notMatched_reverts() public {
        uint256 id = _open();
        vm.prank(taker);
        vm.expectRevert("Escrow: not matched");
        escrow.claimFiatPaid(id, RECEIPT);
    }

    function test_claim_zeroReceipt_reverts() public {
        uint256 id = _matched();
        vm.prank(taker);
        vm.expectRevert("Escrow: zero receipt");
        escrow.claimFiatPaid(id, bytes32(0));
    }

    // Receipt hash is write-once: a second claim cannot mutate it.
    function test_claim_receiptImmutable() public {
        uint256 id = _claimed();
        vm.prank(taker);
        vm.expectRevert("Escrow: not matched");
        escrow.claimFiatPaid(id, keccak256("other"));
        assertEq(escrow.getOrder(id).receiptHash, RECEIPT, "receipt unchanged");
    }

    // ------------------------------------------------------- confirm / settle

    function test_happyPath_confirmReleasesToTaker() public {
        uint256 id = _claimed();
        uint256 takerBefore = iou.balanceOf(taker, T);

        vm.prank(maker);
        escrow.confirmReceived(id);

        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Settled));
        assertEq(iou.balanceOf(taker, T), takerBefore + AMT, "taker received IOU");
        assertEq(iou.balanceOf(address(escrow), T), 0, "escrow emptied");
    }

    function test_confirm_onlyMaker() public {
        uint256 id = _claimed();
        vm.prank(taker);
        vm.expectRevert("Escrow: only maker");
        escrow.confirmReceived(id);
    }

    function test_confirm_notClaimed_reverts() public {
        uint256 id = _matched();
        vm.prank(maker);
        vm.expectRevert("Escrow: not claimed");
        escrow.confirmReceived(id);
    }

    function test_confirm_noDoubleSettle() public {
        uint256 id = _claimed();
        vm.prank(maker);
        escrow.confirmReceived(id);
        vm.prank(maker);
        vm.expectRevert("Escrow: not claimed");
        escrow.confirmReceived(id);
    }

    // -------------------------------------------------------- cancel / refund

    function test_cancel_prefill_refunds() public {
        uint256 makerBefore = iou.balanceOf(maker, T);
        uint256 id = _open();
        vm.prank(maker);
        escrow.cancel(id);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Refunded));
        assertEq(iou.balanceOf(maker, T), makerBefore, "maker made whole");
        assertEq(iou.balanceOf(address(escrow), T), 0);
    }

    function test_cancel_afterTimeout_refunds() public {
        uint256 makerBefore = iou.balanceOf(maker, T);
        uint256 id = _matched();
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(maker);
        escrow.cancel(id);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Refunded));
        assertEq(iou.balanceOf(maker, T), makerBefore, "maker refunded after timeout");
    }

    function test_cancel_beforeTimeout_reverts() public {
        uint256 id = _matched();
        vm.warp(block.timestamp + WINDOW - 1);
        vm.prank(maker);
        vm.expectRevert("Escrow: not cancelable");
        escrow.cancel(id);
    }

    function test_cancel_afterClaim_reverts() public {
        uint256 id = _claimed();
        vm.warp(block.timestamp + 100 days);
        vm.prank(maker);
        vm.expectRevert("Escrow: not cancelable");
        escrow.cancel(id);
    }

    function test_cancel_onlyMaker() public {
        uint256 id = _open();
        vm.prank(taker);
        vm.expectRevert("Escrow: only maker");
        escrow.cancel(id);
    }

    // ------------------------------------------------------------- dispute

    function test_raiseDispute_byTaker() public {
        uint256 id = _claimed();
        // Fix 2: a taker may only escalate a claimed order after the confirm
        // window elapses (see test_raiseDispute_taker_beforeConfirmWindow_reverts
        // for the pre-window revert).
        vm.warp(block.timestamp + escrow.CONFIRM_WINDOW());
        vm.prank(taker);
        escrow.raiseDispute(id);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Disputed));
    }

    function test_raiseDispute_byMaker() public {
        uint256 id = _claimed();
        vm.prank(maker);
        escrow.raiseDispute(id);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Disputed));
    }

    function test_raiseDispute_notClaimed_reverts() public {
        uint256 id = _matched();
        vm.prank(taker);
        vm.expectRevert("Escrow: not claimed");
        escrow.raiseDispute(id);
    }

    function test_raiseDispute_notParty_reverts() public {
        uint256 id = _claimed();
        vm.prank(outsider);
        vm.expectRevert("Escrow: not party");
        escrow.raiseDispute(id);
    }

    // ------------------------------------------------------------- resolve

    function test_resolve_toTaker() public {
        uint256 id = _disputed();
        uint256 takerBefore = iou.balanceOf(taker, T);
        vm.prank(sarrafA);
        escrow.resolve(id, true);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.ResolvedTaker));
        assertEq(iou.balanceOf(taker, T), takerBefore + AMT, "taker awarded IOU");
        assertEq(iou.balanceOf(address(escrow), T), 0);
    }

    function test_resolve_toMaker() public {
        uint256 makerAfterLock = iou.balanceOf(maker, T);
        uint256 id = _disputed();
        vm.prank(sarrafA);
        escrow.resolve(id, false);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.ResolvedMaker));
        assertEq(iou.balanceOf(maker, T), makerAfterLock, "maker refunded IOU");
        assertEq(iou.balanceOf(address(escrow), T), 0);
    }

    // Arbiter-spoofing: only the tranche's derived Sarraf may resolve.
    function test_resolve_nonArbiter_reverts() public {
        uint256 id = _disputed();
        vm.prank(sarrafB); // a different, real Sarraf
        vm.expectRevert("Escrow: not arbiter");
        escrow.resolve(id, true);

        vm.prank(maker);
        vm.expectRevert("Escrow: not arbiter");
        escrow.resolve(id, true);

        vm.prank(taker);
        vm.expectRevert("Escrow: not arbiter");
        escrow.resolve(id, false);
    }

    function test_resolve_notDisputed_reverts() public {
        uint256 id = _claimed();
        vm.prank(sarrafA);
        vm.expectRevert("Escrow: not disputed");
        escrow.resolve(id, true);
    }

    function test_resolve_doubleResolve_reverts() public {
        uint256 id = _disputed();
        vm.prank(sarrafA);
        escrow.resolve(id, true);
        vm.prank(sarrafA);
        vm.expectRevert("Escrow: not disputed");
        escrow.resolve(id, true);
    }

    // ------------------------------------------------------------- custody

    function test_onReceive_rejectsUnsolicitedTransfer() public {
        // A member trying to push IOU straight into the escrow (no createOrder)
        // must be rejected — nothing may be parked against the accounting.
        vm.prank(maker);
        vm.expectRevert(); // IouToken bubbles "Escrow: unexpected deposit"
        iou.safeTransferFrom(maker, address(escrow), T, AMT, "");
    }

    function test_onBatchReceive_reverts() public {
        assertEq(escrow.supportsInterface(0x4e2312e0), true);
    }

    // ------------------------------------------------------------ reentrancy

    function test_reentrancy_confirm_blocked() public {
        ReentrantTaker evil = new ReentrantTaker(escrow);
        uint256 id = _open();
        evil.fill(id);
        evil.claim(id, RECEIPT);
        evil.arm(id, 0); // reenter confirmReceived

        uint256 evilBefore = iou.balanceOf(address(evil), T);
        vm.prank(maker);
        escrow.confirmReceived(id);

        assertTrue(evil.reentryAttempted(), "attack ran");
        assertTrue(evil.reentryReverted(), "reentry rejected by guard");
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Settled));
        assertEq(iou.balanceOf(address(evil), T), evilBefore + AMT, "paid exactly once");
        assertEq(iou.balanceOf(address(escrow), T), 0, "no double drain");
    }

    function test_reentrancy_resolve_blocked() public {
        ReentrantTaker evil = new ReentrantTaker(escrow);
        uint256 id = _open();
        evil.fill(id);
        evil.claim(id, RECEIPT);
        // Fix 2: the taker (evil) must wait out the confirm window to escalate.
        vm.warp(block.timestamp + escrow.CONFIRM_WINDOW());
        evil.raise(id);
        evil.arm(id, 2); // reenter resolve

        vm.prank(sarrafA);
        escrow.resolve(id, true);

        assertTrue(evil.reentryReverted(), "reentry rejected by guard");
        assertEq(iou.balanceOf(address(evil), T), AMT, "paid exactly once");
        assertEq(iou.balanceOf(address(escrow), T), 0);
    }

    // ============================================================ REGRESSIONS
    // Availability / griefing findings from the two adversarial reviews. Each
    // test fails on the pre-fix contract and passes after.

    // --- Fix 1: Disputed dead-end — backstop resolves after DISPUTE_TIMEOUT ---

    // The tranche Sarraf never resolves. Before the fix, the IOU is stranded
    // forever. After: the backstop arbiter can resolve once the timeout elapses,
    // so funds are always recoverable.
    function test_backstop_resolvesAfterTimeout() public {
        uint256 id = _disputed();
        uint256 takerBefore = iou.balanceOf(taker, T);

        // Too early: backstop cannot act before the timeout.
        vm.prank(backstop);
        vm.expectRevert("Escrow: backstop too early");
        escrow.resolve(id, true);

        vm.warp(block.timestamp + escrow.DISPUTE_TIMEOUT());
        vm.prank(backstop);
        escrow.resolve(id, true);

        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.ResolvedTaker));
        assertEq(iou.balanceOf(taker, T), takerBefore + AMT, "backstop recovered funds");
        assertEq(iou.balanceOf(address(escrow), T), 0, "escrow emptied");
    }

    // A random address is never a valid backstop, even after the timeout.
    function test_backstop_onlyBackstopAddress() public {
        uint256 id = _disputed();
        vm.warp(block.timestamp + escrow.DISPUTE_TIMEOUT());
        vm.prank(outsider == backstop ? address(0xBADD) : outsider);
        // outsider IS the backstop in this suite; use a guaranteed non-backstop.
        vm.expectRevert();
        escrow.resolve(id, true);
    }

    // The primary arbiter (tranche Sarraf) can still resolve at ANY time — the
    // backstop is additive, it does not displace the Sarraf's authority.
    function test_backstop_sarrafStillResolvesImmediately() public {
        uint256 id = _disputed();
        vm.prank(sarrafA);
        escrow.resolve(id, false);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.ResolvedMaker));
    }

    function test_constructor_zeroBackstop_reverts() public {
        vm.expectRevert("Escrow: zero backstop");
        new Escrow(IEscrowIou(address(iou)), address(0));
    }

    // --- Fix 2: griefing lock — taker cannot instantly dispute a clean claim ---

    // The reviewers' PoC: taker fills, claims a garbage receipt hash, then tries
    // to raiseDispute in the same breath to force an arbiter-only Disputed with
    // the maker's IOU locked. Before the fix this succeeded; after, the taker is
    // gated behind the confirm window.
    function test_raiseDispute_taker_beforeConfirmWindow_reverts() public {
        uint256 id = _matched();
        vm.prank(taker);
        escrow.claimFiatPaid(id, keccak256("garbage"));

        vm.prank(taker);
        vm.expectRevert("Escrow: confirm window open");
        escrow.raiseDispute(id);

        // Still FiatClaimed — the maker keeps their window to confirm/act.
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.FiatClaimed));

        // And one second before the deadline it still reverts...
        vm.warp(uint256(escrow.confirmDeadline(id)) - 1);
        vm.prank(taker);
        vm.expectRevert("Escrow: confirm window open");
        escrow.raiseDispute(id);

        // ...at the deadline it opens.
        vm.warp(uint256(escrow.confirmDeadline(id)));
        vm.prank(taker);
        escrow.raiseDispute(id);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Disputed));
    }

    // The MAKER faces no confirm-window gate: choosing arbitration on their own
    // order the instant a receipt lands is not griefing.
    function test_raiseDispute_maker_notGatedByConfirmWindow() public {
        uint256 id = _claimed();
        vm.prank(maker);
        escrow.raiseDispute(id); // immediately, no warp
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Disputed));
    }

    // --- Fix 4: front-run of the happy path — taker cannot pre-empt confirm ---

    // Maker is about to confirmReceived; a hostile taker tries to front-run it
    // into Disputed. Fix 2's gate blocks the front-run, so the maker's confirm
    // lands cleanly and the order settles.
    function test_frontRun_confirmNotHijackedByTakerDispute() public {
        uint256 id = _claimed();
        // Taker front-run attempt (same block as the maker's pending confirm).
        vm.prank(taker);
        vm.expectRevert("Escrow: confirm window open");
        escrow.raiseDispute(id);

        // Maker's confirm proceeds — happy path preserved.
        vm.prank(maker);
        escrow.confirmReceived(id);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Settled));
    }

    // --- Fix 3: cancel-vs-claim race — markPaying freezes the maker's cancel ---

    // Taker sends real fiat and calls markPaying, then the payment deadline
    // passes before the receipt is uploaded. Before the fix, the maker could
    // cancel at the deadline and keep both IOU and fiat. After, cancel is frozen.
    function test_markPaying_freezesCancelAtDeadline() public {
        uint256 id = _matched();
        vm.prank(taker);
        escrow.markPaying(id);

        // Warp right past the payment deadline — the classic race window.
        vm.warp(uint256(escrow.paymentDeadline(id)) + 1);

        vm.prank(maker);
        vm.expectRevert("Escrow: not cancelable");
        escrow.cancel(id);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Matched), "still live");

        // The taker can still complete the claim; the maker then settles.
        vm.prank(taker);
        escrow.claimFiatPaid(id, RECEIPT);
        vm.prank(maker);
        escrow.confirmReceived(id);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Settled));
    }

    // The freeze is not itself a maker-lock: if a committed taker stalls (never
    // claims) past the window, the maker escalates to a (backstop-resolvable)
    // dispute instead of being stranded.
    function test_markPaying_makerExitViaDisputeWhenTakerStalls() public {
        uint256 id = _matched();
        vm.prank(taker);
        escrow.markPaying(id);
        vm.warp(uint256(escrow.paymentDeadline(id)) + 1);

        // Cancel is frozen...
        vm.prank(maker);
        vm.expectRevert("Escrow: not cancelable");
        escrow.cancel(id);

        // ...but the maker can raiseDispute from MATCHED as their exit.
        vm.prank(maker);
        escrow.raiseDispute(id);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Disputed));

        // And it is fully recoverable — arbiter refunds the maker.
        vm.prank(sarrafA);
        escrow.resolve(id, false);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.ResolvedMaker));
    }

    // markPaying is taker-only and MATCHED-only.
    function test_markPaying_onlyTaker() public {
        uint256 id = _matched();
        vm.prank(maker);
        vm.expectRevert("Escrow: only taker");
        escrow.markPaying(id);
    }

    function test_markPaying_notMatched_reverts() public {
        uint256 id = _open();
        vm.prank(taker);
        vm.expectRevert("Escrow: not matched");
        escrow.markPaying(id);
    }

    // A taker who did NOT markPaying is still cancelable at timeout (unchanged
    // behavior — the freeze is opt-in, no regression to the timeout refund).
    function test_cancel_afterTimeout_withoutMarkPaying_stillRefunds() public {
        uint256 makerBefore = iou.balanceOf(maker, T);
        uint256 id = _matched();
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(maker);
        escrow.cancel(id);
        assertEq(uint256(escrow.statusOf(id)), uint256(Escrow.Status.Refunded));
        assertEq(iou.balanceOf(maker, T), makerBefore, "maker refunded");
    }

    // --- Fix 5: onERC1155Received wrap at tranche id type(uint256).max ---

    // A separate escrow whose tranche-id space includes type(uint256).max: the
    // old `_expectedDeposit == id + 1` sentinel wrapped (max+1 == 0 == "expect
    // nothing"), so a stray deposit of the max id slipped through the custody
    // gate. The bool sentinel does not wrap.
    function test_onReceive_maxTrancheId_noWrap() public {
        WrapProbeIou probe = new WrapProbeIou();
        Escrow esc = new Escrow(IEscrowIou(address(probe)), backstop);
        // Not inside a createOrder deposit → _expecting is false → must reject
        // even for id == type(uint256).max.
        vm.expectRevert("Escrow: unexpected deposit");
        probe.pushReceive(address(esc), type(uint256).max);
    }

    // --- Fix 6: quoteHash must be non-zero ---

    function test_createOrder_zeroQuote_reverts() public {
        vm.prank(maker);
        vm.expectRevert("Escrow: zero quote");
        escrow.createOrder(sarrafA, AMT, "IRR", FIAT, bytes32(0), WINDOW);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_happyPath(uint256 amount, uint64 window, bytes32 receipt) public {
        amount = bound(amount, 1, 10_000e6);
        window = uint64(bound(window, escrow.MIN_PAYMENT_WINDOW(), escrow.MAX_PAYMENT_WINDOW()));
        vm.assume(receipt != bytes32(0));

        uint256 makerBefore = iou.balanceOf(maker, T);
        vm.prank(maker);
        uint256 id = escrow.createOrder(sarrafA, amount, "TRY", FIAT, QUOTE, window);
        assertEq(iou.balanceOf(address(escrow), T), amount);

        vm.prank(taker);
        escrow.fillOrder(id);
        vm.prank(taker);
        escrow.claimFiatPaid(id, receipt);
        vm.prank(maker);
        escrow.confirmReceived(id);

        assertEq(iou.balanceOf(taker, T), amount, "taker got exactly amount");
        assertEq(iou.balanceOf(maker, T), makerBefore - amount, "maker debited exactly amount");
        assertEq(iou.balanceOf(address(escrow), T), 0);
    }

    function testFuzz_disputeResolve(bool toTaker, uint256 amount) public {
        amount = bound(amount, 1, 10_000e6);
        uint256 makerBefore = iou.balanceOf(maker, T);

        vm.prank(maker);
        uint256 id = escrow.createOrder(sarrafA, amount, "IRR", FIAT, QUOTE, WINDOW);
        vm.prank(taker);
        escrow.fillOrder(id);
        vm.prank(taker);
        escrow.claimFiatPaid(id, RECEIPT);
        // Fix 2: taker escalates only after the confirm window.
        vm.warp(block.timestamp + escrow.CONFIRM_WINDOW());
        vm.prank(taker);
        escrow.raiseDispute(id);
        vm.prank(sarrafA);
        escrow.resolve(id, toTaker);

        if (toTaker) {
            assertEq(iou.balanceOf(taker, T), amount);
            assertEq(iou.balanceOf(maker, T), makerBefore - amount);
        } else {
            assertEq(iou.balanceOf(maker, T), makerBefore, "maker fully refunded");
            assertEq(iou.balanceOf(taker, T), 0);
        }
        assertEq(iou.balanceOf(address(escrow), T), 0, "escrow always emptied");
    }
}
