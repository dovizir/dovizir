// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {
    IIouToken,
    IMemberRegistry,
    IReservePool,
    IInsuranceFund,
    ISarrafRegistry,
    INoteVault
} from "../../src/interfaces/IDovizir.sol";
import {IMockUsdt, IErc1155Core, DovizirSystem} from "../../src/interfaces/IAcceptanceDeployer.sol";
import {TranscriptLib} from "../../src/TranscriptLib.sol";

/// Bounded-op handler for the invariant suite (Invariants.t.sol). Only the
/// op* functions are targeted. Ghost variables track note payments so the
/// invariants can assert "no serial ever pays twice".
///
/// The handler deliberately performs only PROTOCOL-legal action shapes plus
/// byte-identical reconcile replays (which a correct implementation must
/// reject or no-op); it never constructs a carver-signed conflicting
/// transcript, so no seizure/conviction path should ever move value during
/// invariant runs.
contract DovizirHandler is Test {
    IMockUsdt internal usdt;
    IIouToken internal iou;
    IErc1155Core internal iou1155;
    IReservePool internal pool;
    INoteVault internal vault;

    address[] internal sarrafs;
    address[] internal members; // members[i] sponsored by memberSarraf[i]
    uint256[] internal memberPks;
    address[] internal memberSarraf;
    address[] internal recipients;
    address[] internal holders; // members + recipients (the closed holder set)

    struct BatchInfo {
        uint256 memberIdx;
        bytes32 root;
        uint64 expiry;
        uint256 remaining; // ghost: locked value not yet reconciled/refunded
        uint256 spentCount;
        bool refunded;
        bytes32[] serials;
    }

    struct SpentRecord {
        uint256 batchIdx;
        bytes32 serial;
        address recipient;
        bytes32[] proof;
        bytes transcript;
        bytes sig;
    }

    BatchInfo[] internal batches;
    SpentRecord[] internal spentRecords;
    uint256 internal batchSalt;

    // ------------------------------------------------------ ghost variables
    mapping(bytes32 => uint256) public timesPaid;
    bytes32[] public paidSerials;

    constructor(
        DovizirSystem memory sys,
        address[] memory sarrafs_,
        address[] memory members_,
        uint256[] memory memberPks_,
        address[] memory memberSarraf_,
        address[] memory recipients_
    ) {
        usdt = sys.usdt;
        iou = sys.iouToken;
        iou1155 = IErc1155Core(address(sys.iouToken));
        pool = sys.reservePool;
        vault = sys.noteVault;
        sarrafs = sarrafs_;
        members = members_;
        memberPks = memberPks_;
        memberSarraf = memberSarraf_;
        recipients = recipients_;
        for (uint256 i; i < members_.length; ++i) holders.push(members_[i]);
        for (uint256 i; i < recipients_.length; ++i) holders.push(recipients_[i]);
    }

    function paidSerialCount() external view returns (uint256) {
        return paidSerials.length;
    }

    function _id(address sarraf) internal pure returns (uint256) {
        return uint256(uint160(sarraf));
    }

    // ---------------------------------------------------------------- ops

    function opDeposit(uint256 sarrafSeed, uint256 amount) external {
        address sarraf = sarrafs[sarrafSeed % sarrafs.length];
        amount = bound(amount, 1e6, 500_000e6);
        usdt.mint(sarraf, amount);
        vm.startPrank(sarraf);
        usdt.approve(address(pool), amount);
        pool.deposit(amount);
        vm.stopPrank();
    }

    function opIssue(uint256 memberSeed, uint256 amount) external {
        uint256 m = memberSeed % members.length;
        address sarraf = memberSarraf[m];
        uint256 headroom = pool.backingOf(sarraf) - pool.outstandingOf(sarraf);
        if (headroom == 0) return;
        amount = bound(amount, 1, headroom);
        vm.prank(sarraf);
        pool.issue(members[m], amount);
    }

    function opRedeem(uint256 holderSeed, uint256 sarrafSeed, uint256 amount) external {
        address holder = holders[holderSeed % holders.length];
        address sarraf = sarrafs[sarrafSeed % sarrafs.length];
        uint256 bal = iou1155.balanceOf(holder, _id(sarraf));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(holder);
        pool.redeem(sarraf, amount);
    }

    function opTransfer(uint256 fromSeed, uint256 toSeed, uint256 sarrafSeed, uint256 amount) external {
        address from = holders[fromSeed % holders.length];
        address to = holders[toSeed % holders.length];
        if (from == to) return;
        uint256 id = _id(sarrafs[sarrafSeed % sarrafs.length]);
        uint256 bal = iou1155.balanceOf(from, id);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        iou1155.safeTransferFrom(from, to, id, amount, "");
    }

    function opCarve(uint256 memberSeed, uint256 amount, uint256 ttl) external {
        uint256 m = memberSeed % members.length;
        address member = members[m];
        uint256 bal = iou1155.balanceOf(member, _id(memberSarraf[m]));
        uint256 cap = vault.capOf(member);
        uint256 locked = vault.lockedOf(member);
        uint256 capacity = cap > locked ? cap - locked : 0;
        uint256 max = bal < capacity ? bal : capacity;
        if (max == 0) return;
        amount = bound(amount, 1, max);
        uint64 expiry = uint64(block.timestamp + bound(ttl, 1 days, 20 days));

        bytes32[] memory serials = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            serials[i] = keccak256(abi.encode("handler.serial", batchSalt, i));
        }
        ++batchSalt;
        bytes32 root = TranscriptLib.computeRoot(serials);

        vm.prank(member);
        vault.carve(root, amount, expiry);
        batches.push(
            BatchInfo({
                memberIdx: m,
                root: root,
                expiry: expiry,
                remaining: amount,
                spentCount: 0,
                refunded: false,
                serials: serials
            })
        );
    }

    function opReconcile(uint256 batchSeed, uint256 recipientSeed, uint256 amount) external {
        if (batches.length == 0) return;
        uint256 b = batchSeed % batches.length;
        BatchInfo storage batch = batches[b];
        if (batch.refunded || batch.remaining == 0) return;
        if (batch.spentCount >= batch.serials.length) return;
        if (block.timestamp >= batch.expiry) return;

        amount = bound(amount, 1, batch.remaining);
        _submitFirstPresentation(b, recipients[recipientSeed % recipients.length], amount);
    }

    function _submitFirstPresentation(uint256 b, address recipient, uint256 amount) internal {
        BatchInfo storage batch = batches[b];
        bytes32 serial = batch.serials[batch.spentCount];
        uint256 trancheId = _id(memberSarraf[batch.memberIdx]);

        TranscriptLib.Invoice memory inv = TranscriptLib.Invoice({
            recipient: recipient,
            amount: amount,
            nonce: keccak256(abi.encode("handler.inv", b, batch.spentCount))
        });
        bytes memory transcript = TranscriptLib.encodeTranscript(inv);
        bytes memory sig = _sign(
            memberPks[batch.memberIdx],
            TranscriptLib.spendDigest(serial, TranscriptLib.invoiceHash(inv), batch.expiry, batch.root)
        );
        bytes32[] memory proof = TranscriptLib.computeProof(batch.serials, batch.spentCount);

        uint256 balBefore = iou1155.balanceOf(recipient, trancheId);
        vault.reconcile(batch.root, serial, proof, transcript, sig);

        if (iou1155.balanceOf(recipient, trancheId) > balBefore) {
            if (timesPaid[serial] == 0) paidSerials.push(serial);
            ++timesPaid[serial];
            batch.remaining -= amount;
            ++batch.spentCount;
            spentRecords.push(
                SpentRecord({
                    batchIdx: b,
                    serial: serial,
                    recipient: recipient,
                    proof: proof,
                    transcript: transcript,
                    sig: sig
                })
            );
        }
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Byte-identical replay of a previously accepted transcript. A correct
    /// implementation reverts (canonical: "ALREADY_RECONCILED") or no-ops; if
    /// it ever pays again, timesPaid exceeds 1 and the invariant fails.
    function opReplay(uint256 recordSeed) external {
        if (spentRecords.length == 0) return;
        SpentRecord storage rec = spentRecords[recordSeed % spentRecords.length];
        BatchInfo storage batch = batches[rec.batchIdx];
        if (block.timestamp >= batch.expiry) return;

        uint256 id = _id(memberSarraf[batch.memberIdx]);
        uint256 balBefore = iou1155.balanceOf(rec.recipient, id);
        (bool ok,) = address(vault).call(
            abi.encodeCall(INoteVault.reconcile, (batch.root, rec.serial, rec.proof, rec.transcript, rec.sig))
        );
        if (ok && iou1155.balanceOf(rec.recipient, id) > balBefore) {
            ++timesPaid[rec.serial]; // invariant_noSerialPaysTwice will catch this
        }
    }

    function opRefundExpired(uint256 batchSeed) external {
        if (batches.length == 0) return;
        uint256 b = batchSeed % batches.length;
        BatchInfo storage batch = batches[b];
        if (batch.refunded || block.timestamp <= batch.expiry) return;
        vm.prank(members[batch.memberIdx]);
        vault.refundExpired(batch.root);
        batch.refunded = true;
        batch.remaining = 0;
    }

    function opWarp(uint256 delta) external {
        vm.warp(block.timestamp + bound(delta, 1 hours, 3 days));
    }
}
