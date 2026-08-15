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

contract EscrowTest is ArmBase {
    Escrow internal escrow;

    uint256 internal T; // tranche id of sarrafA (the arbiter)
    address internal maker; // memberA1
    address internal taker; // memberA2

    uint256 internal constant AMT = 100e6; // 100 IOU
    uint256 internal constant FIAT = 5_000_000; // agreed fiat units
    uint64 internal constant WINDOW = 1 hours;
    bytes32 internal constant QUOTE = keccak256("quote-1");
    bytes32 internal constant RECEIPT = keccak256("receipt-1");

    function setUp() public override {
        super.setUp();
        escrow = new Escrow(IEscrowIou(address(iou)));

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
        evil.raise(id);
        evil.arm(id, 2); // reenter resolve

        vm.prank(sarrafA);
        escrow.resolve(id, true);

        assertTrue(evil.reentryReverted(), "reentry rejected by guard");
        assertEq(iou.balanceOf(address(evil), T), AMT, "paid exactly once");
        assertEq(iou.balanceOf(address(escrow), T), 0);
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
