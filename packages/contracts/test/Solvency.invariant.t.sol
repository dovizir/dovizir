// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArmBase} from "./ArmBase.sol";
import {Test} from "forge-std/Test.sol";
import {MockUsdt} from "../src/MockUsdt.sol";
import {IouToken} from "../src/IouToken.sol";
import {ReservePool} from "../src/ReservePool.sol";
import {NoteVault} from "../src/NoteVault.sol";
import {TranscriptLib} from "dovizir-acceptance/TranscriptLib.sol";

/// Bounded-op handler for Arm A's solvency invariants. Complements the
/// referee's supply invariants with CASH solvency properties: every liability
/// account is fully collateralized by tokens actually held.
contract SolvencyHandler is Test {
    MockUsdt internal usdt;
    IouToken internal iou;
    ReservePool internal pool;
    NoteVault internal vault;

    address public immutable sarraf;
    address[] public members;
    uint256[] public memberPks;
    address public immutable recipient;

    struct HBatch {
        address member;
        uint256 pk;
        bytes32 root;
        bytes32[] serials;
        uint64 expiry;
        uint256 spent;
        uint256 remaining;
        bool refunded;
    }

    HBatch[] public hBatches;
    uint256 internal salt;

    constructor(
        MockUsdt usdt_,
        IouToken iou_,
        ReservePool pool_,
        NoteVault vault_,
        address sarraf_,
        address[] memory members_,
        uint256[] memory memberPks_,
        address recipient_
    ) {
        usdt = usdt_;
        iou = iou_;
        pool = pool_;
        vault = vault_;
        sarraf = sarraf_;
        members = members_;
        memberPks = memberPks_;
        recipient = recipient_;
    }

    function opDeposit(uint256 amount) external {
        amount = bound(amount, 1e6, 200_000e6);
        usdt.mint(sarraf, amount);
        vm.startPrank(sarraf);
        usdt.approve(address(pool), amount);
        pool.deposit(amount);
        vm.stopPrank();
    }

    function opIssue(uint256 memberSeed, uint256 amount) external {
        address member = members[memberSeed % members.length];
        uint256 headroom = pool.backingOf(sarraf) - pool.outstandingOf(sarraf);
        if (headroom == 0) return;
        amount = bound(amount, 1, headroom);
        vm.prank(sarraf);
        pool.issue(member, amount);
    }

    function opRedeem(uint256 memberSeed, uint256 amount) external {
        address member = members[memberSeed % members.length];
        uint256 bal = iou.balanceOf(member, uint256(uint160(sarraf)));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(member);
        pool.redeem(sarraf, amount);
    }

    function opCarve(uint256 memberSeed, uint256 amount, uint256 ttl) external {
        uint256 m = memberSeed % members.length;
        address member = members[m];
        uint256 bal = iou.balanceOf(member, uint256(uint160(sarraf)));
        uint256 capacity = vault.capOf(member) - vault.lockedOf(member);
        uint256 max = bal < capacity ? bal : capacity;
        if (max == 0) return;
        amount = bound(amount, 1, max);

        bytes32[] memory serials = new bytes32[](2);
        serials[0] = keccak256(abi.encode("solvency", salt, uint256(0)));
        serials[1] = keccak256(abi.encode("solvency", salt, uint256(1)));
        ++salt;
        bytes32 root = TranscriptLib.computeRoot(serials);
        uint64 expiry = uint64(block.timestamp + bound(ttl, 1 days, 10 days));

        vm.prank(member);
        vault.carve(root, amount, expiry);
        hBatches.push(
            HBatch({
                member: member,
                pk: memberPks[m],
                root: root,
                serials: serials,
                expiry: expiry,
                spent: 0,
                remaining: amount,
                refunded: false
            })
        );
    }

    function opReconcile(uint256 batchSeed, uint256 amount) external {
        if (hBatches.length == 0) return;
        HBatch storage b = hBatches[batchSeed % hBatches.length];
        if (b.refunded || b.remaining == 0 || b.spent >= b.serials.length) return;
        if (block.timestamp >= b.expiry) return;
        amount = bound(amount, 1, b.remaining);

        bytes32 serial = b.serials[b.spent];
        TranscriptLib.Invoice memory inv = TranscriptLib.Invoice({
            recipient: recipient,
            amount: amount,
            nonce: keccak256(abi.encode("inv", b.root, b.spent))
        });
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(b.pk, TranscriptLib.spendDigest(serial, TranscriptLib.invoiceHash(inv)));
        vault.reconcile(
            b.root,
            serial,
            TranscriptLib.computeProof(b.serials, b.spent),
            TranscriptLib.encodeTranscript(inv),
            abi.encodePacked(r, s, v)
        );
        b.remaining -= amount;
        ++b.spent;
    }

    function opRefund(uint256 batchSeed) external {
        if (hBatches.length == 0) return;
        HBatch storage b = hBatches[batchSeed % hBatches.length];
        if (b.refunded || b.remaining == 0 || block.timestamp < b.expiry) return;
        vault.refundExpired(b.root);
        b.refunded = true;
        b.remaining = 0;
    }

    function opWarp(uint256 delta) external {
        vm.warp(block.timestamp + bound(delta, 1 hours, 4 days));
    }
}

/// Cash-solvency invariants over the concrete Arm A system: the referee
/// checks supply identities; these check that every account of value is
/// backed by tokens the contract actually holds.
contract SolvencyInvariantTest is ArmBase {
    SolvencyHandler internal handler;
    address[] internal memberList;

    function setUp() public override {
        super.setUp();
        _certify(sarrafA);
        _addMember(sarrafA, memberA1);
        _addMember(sarrafA, memberA2);
        _deposit(sarrafA, 300_000e6);
        memberList = [memberA1, memberA2];
        uint256[] memory pks = new uint256[](2);
        pks[0] = memberA1Pk;
        pks[1] = memberA2Pk;

        handler = new SolvencyHandler(usdt, iou, pool, vault, sarrafA, memberList, pks, recipient1);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = SolvencyHandler.opDeposit.selector;
        selectors[1] = SolvencyHandler.opIssue.selector;
        selectors[2] = SolvencyHandler.opRedeem.selector;
        selectors[3] = SolvencyHandler.opCarve.selector;
        selectors[4] = SolvencyHandler.opReconcile.selector;
        selectors[5] = SolvencyHandler.opRefund.selector;
        selectors[6] = SolvencyHandler.opWarp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// The pool holds exactly the USDT it owes: balance == totalDeposits ==
    /// Σ backing (fees and payouts leave in the same transaction).
    function invariant_poolHoldsExactlyTotalDeposits() public view {
        assertEq(usdt.balanceOf(address(pool)), pool.totalDeposits(), "pool cash == TVL");
        assertEq(pool.totalDeposits(), pool.backingOf(sarrafA), "single-sarraf TVL identity");
    }

    /// The fund's cash fully collateralizes its fee books.
    function invariant_fundCashBacksReserveBooks() public view {
        assertEq(usdt.balanceOf(address(fund)), fund.totalReserves(), "fund cash == books");
    }

    /// Vault escrow custody equals the aggregate lockedOf bookkeeping.
    function invariant_vaultCustodyEqualsLockedOf() public view {
        uint256 locked;
        for (uint256 i; i < memberList.length; ++i) {
            locked += vault.lockedOf(memberList[i]);
        }
        assertEq(iou.balanceOf(address(vault), _id(sarrafA)), locked, "escrow == sum of lockedOf");
    }

    /// Nobody's tranche balance plus locked value can exceed what was issued.
    function invariant_outstandingCoversAllHoldings() public view {
        uint256 total;
        for (uint256 i; i < memberList.length; ++i) {
            total += iou.balanceOf(memberList[i], _id(sarrafA));
            total += vault.lockedOf(memberList[i]);
        }
        total += iou.balanceOf(recipient1, _id(sarrafA));
        assertEq(total, pool.outstandingOf(sarrafA), "holdings identity");
    }
}
