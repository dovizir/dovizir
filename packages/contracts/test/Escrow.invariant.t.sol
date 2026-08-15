// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArmBase} from "./ArmBase.sol";
import {Escrow, IEscrowIou} from "../src/Escrow.sol";

/// @dev Drives the escrow through random-but-legal-shaped sequences. Illegal
/// transitions revert inside the try/catch and are dropped, so the fuzzer
/// explores the whole state space without aborting a run. Everything runs on
/// ONE tranche so the escrow's IOU balance is directly comparable to the sum of
/// the still-locked orders.
contract EscrowHandler is Test {
    Escrow public escrow;
    IEscrowIou public iou;
    uint256 public T;
    address public maker;
    address public taker;
    address public arbiter;

    uint256[] public orderIds;
    /// ghost: orders that have paid out (must never pay again).
    mapping(uint256 => bool) public paidOut;
    uint256 public doublePayViolations;

    constructor(Escrow escrow_, IEscrowIou iou_, address maker_, address taker_, address arbiter_, uint256 tranche) {
        escrow = escrow_;
        iou = iou_;
        maker = maker_;
        taker = taker_;
        arbiter = arbiter_;
        T = tranche;
    }

    function _pick(uint256 seed) internal view returns (uint256 id, bool ok) {
        if (orderIds.length == 0) return (0, false);
        return (orderIds[seed % orderIds.length], true);
    }

    function create(uint256 amount, uint64 window) external {
        amount = bound(amount, 1, 500e6);
        window = uint64(bound(window, escrow.MIN_PAYMENT_WINDOW(), escrow.MAX_PAYMENT_WINDOW()));
        if (iou.balanceOf(maker, T) < amount) return;
        vm.prank(maker);
        try escrow.createOrder(arbiter, amount, "IRR", 1_000, keccak256("q"), window) returns (uint256 id) {
            orderIds.push(id);
        } catch {}
    }

    function fill(uint256 seed) external {
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        vm.prank(taker);
        try escrow.fillOrder(id) {} catch {}
    }

    function claim(uint256 seed, bytes32 h) external {
        (uint256 id, bool ok) = _pick(seed);
        if (!ok || h == bytes32(0)) return;
        vm.prank(taker);
        try escrow.claimFiatPaid(id, h) {} catch {}
    }

    function confirm(uint256 seed) external {
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        vm.prank(maker);
        try escrow.confirmReceived(id) {
            _markPaid(id);
        } catch {}
    }

    function cancel(uint256 seed) external {
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        vm.prank(maker);
        try escrow.cancel(id) {
            _markPaid(id);
        } catch {}
    }

    function dispute(uint256 seed) external {
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        // Raise as the MAKER: the maker may escalate a claimed order at any time,
        // whereas a taker is now gated behind the confirm window — so raising as
        // the maker keeps the fuzzer reaching DISPUTED without depending on warp
        // ordering. Resolve fairness is exercised by resolve() below.
        vm.prank(maker);
        try escrow.raiseDispute(id) {} catch {}
    }

    function resolve(uint256 seed, bool toTaker) external {
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        vm.prank(arbiter);
        try escrow.resolve(id, toTaker) {
            _markPaid(id);
        } catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 5 days));
    }

    function _markPaid(uint256 id) internal {
        if (paidOut[id]) doublePayViolations++;
        paidOut[id] = true;
    }

    function orderCount() external view returns (uint256) {
        return orderIds.length;
    }
}

contract EscrowInvariantTest is ArmBase {
    Escrow internal escrow;
    EscrowHandler internal handler;
    uint256 internal T;

    function setUp() public override {
        super.setUp();
        escrow = new Escrow(IEscrowIou(address(iou)), outsider); // outsider = backstop

        _certify(sarrafA);
        _addMember(sarrafA, memberA1);
        _addMember(sarrafA, memberA2);
        _issueBacked(sarrafA, memberA1, 1_000_000e6);
        T = _id(sarrafA);

        // memberA1 is the maker: holds the IOU and approves the escrow to custody.
        vm.prank(memberA1);
        iou.setApprovalForAll(address(escrow), true);

        handler = new EscrowHandler(escrow, IEscrowIou(address(iou)), memberA1, memberA2, sarrafA, T);
        targetContract(address(handler));
    }

    /// Solvency: the escrow's IOU balance for the tranche equals the sum of the
    /// amounts of orders still in a locked (non-terminal) state. If any release
    /// path paid the wrong amount or double-paid, this diverges.
    function invariant_escrowBalanceEqualsLocked() public view {
        uint256 locked;
        uint256 n = handler.orderCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.orderIds(i);
            Escrow.Order memory o = escrow.getOrder(id);
            Escrow.Status s = o.status;
            if (
                s == Escrow.Status.Open || s == Escrow.Status.Matched || s == Escrow.Status.FiatClaimed
                    || s == Escrow.Status.Disputed
            ) {
                locked += o.usdtAmount;
            }
        }
        assertEq(iou.balanceOf(address(escrow), T), locked, "escrow balance == locked sum");
    }

    /// No order ever pays out more than once.
    function invariant_noDoublePay() public view {
        assertEq(handler.doublePayViolations(), 0, "an order paid out twice");
    }
}
