// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {INoteVault, IMemberRegistry} from "dovizir-acceptance/interfaces/IDovizir.sol";
import {TranscriptLib} from "dovizir-acceptance/TranscriptLib.sol";
import {IouToken} from "./IouToken.sol";
import {InsuranceFund} from "./InsuranceFund.sol";

/// @title NoteVault — offline-note escrow: carve, recipient-bound reconcile,
/// double-spend conviction, expiry refunds
/// @notice Implements the frozen INoteVault against the frozen TranscriptLib
/// encoding (invoice typehash, raw-digest carver signature, sorted-pair
/// merkle). Custody model: carve TRANSFERS the member's sponsor-tranche IOU
/// into the vault (the suite pre-approves the vault as operator); reconcile
/// and refund transfer back out. No vault minting is needed, so invariant (a)
/// (outstanding == circulating + Σ lockedOf) holds structurally.
///
/// Double-spend handling (frozen spec addition #6):
///  - a second CARVER-SIGNED transcript for a spent serial with a different
///    invoice convicts: the carver's ENTIRE remaining locked value — across
///    all their batches — is seized (lockedOf → 0), the victim is made whole
///    for exactly the invoice amount (carver-tranche IOU first, then USDT via
///    InsuranceFund.payClaim for any shortfall), and seizure excess goes to
///    the InsuranceFund under its 50/50 split bookkeeping (adjudication
///    2026-08-13);
///  - a byte-identical resubmission is NOT a double-spend: it reverts with
///    ALREADY_RECONCILED (canonical behavior);
///  - a conflicting transcript NOT signed by the carver reverts without
///    conviction.
///
/// Cross-batch seizure is O(1) via a per-carver seizure epoch: each batch
/// records the carver's epoch at carve time; a conviction bumps the carver's
/// epoch, instantly zeroing the effective remainder of every pre-existing
/// batch without enumeration.
contract NoteVault is INoteVault {
    // ------------------------------------------------------------- constants
    /// M1 uniform base cap (referee floor: >= 50_000e6).
    uint256 public constant BASE_CAP = 100_000e6;

    // --------------------------------------------------------------- storage
    struct Batch {
        address carver;
        address sarraf; // sponsor at carve time — the locked tranche
        uint64 expiry;
        uint64 seizureEpoch; // carver's epoch when carved
        bool refunded;
        uint256 remaining; // raw remainder; effective 0 if epoch is stale
    }

    IouToken public immutable iou;
    IMemberRegistry public immutable memberRegistry;
    InsuranceFund public immutable insuranceFund;

    mapping(bytes32 => Batch) internal _batches;
    mapping(address => uint256) internal _lockedOf;
    mapping(address => uint64) public seizureEpochOf;
    mapping(bytes32 => bool) internal _spent;
    /// serial => invoiceHash accepted at first presentation (byte-identity key).
    mapping(bytes32 => bytes32) public acceptedInvoiceHash;

    constructor(IouToken iou_, IMemberRegistry memberRegistry_, InsuranceFund insuranceFund_) {
        require(
            address(iou_) != address(0) && address(memberRegistry_) != address(0)
                && address(insuranceFund_) != address(0),
            "NoteVault: zero address"
        );
        iou = iou_;
        memberRegistry = memberRegistry_;
        insuranceFund = insuranceFund_;
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc INoteVault
    function isSpent(bytes32 serial) external view returns (bool) {
        return _spent[serial];
    }

    /// @inheritdoc INoteVault
    function capOf(address member) public view returns (uint256) {
        return memberRegistry.isMember(member) ? BASE_CAP : 0;
    }

    /// @inheritdoc INoteVault
    function lockedOf(address member) external view returns (uint256) {
        return _lockedOf[member];
    }

    /// @notice Effective unspent remainder of a batch (0 once its carver was
    /// convicted after it was carved, or after refund).
    function remainingOf(bytes32 batchRoot) public view returns (uint256) {
        Batch storage b = _batches[batchRoot];
        return _effectiveRemaining(b);
    }

    // ------------------------------------------------------------------ carve

    /// @inheritdoc INoteVault
    function carve(bytes32 batchRoot, uint256 amount, uint64 expiry) external {
        require(batchRoot != bytes32(0), "NoteVault: zero root");
        require(_batches[batchRoot].carver == address(0), "NoteVault: batch exists");
        require(amount > 0, "NoteVault: zero amount");
        require(expiry > block.timestamp, "NoteVault: expiry in past");
        address sarraf = memberRegistry.sarrafOf(msg.sender);
        require(sarraf != address(0), "NoteVault: not a member");
        require(_lockedOf[msg.sender] + amount <= capOf(msg.sender), "NoteVault: cap exceeded");

        _batches[batchRoot] = Batch({
            carver: msg.sender,
            sarraf: sarraf,
            expiry: expiry,
            seizureEpoch: seizureEpochOf[msg.sender],
            refunded: false,
            remaining: amount
        });
        _lockedOf[msg.sender] += amount;
        // Escrow the sponsor-tranche IOU (vault is a pre-approved operator).
        iou.safeTransferFrom(msg.sender, address(this), uint256(uint160(sarraf)), amount, "");
        emit Carved(msg.sender, batchRoot, amount, expiry);
    }

    // -------------------------------------------------------------- reconcile

    /// @inheritdoc INoteVault
    function reconcile(
        bytes32 batchRoot,
        bytes32 serial,
        bytes32[] calldata proof,
        bytes calldata transcript,
        bytes calldata carverSig
    ) external {
        Batch storage b = _batches[batchRoot];
        require(b.carver != address(0), "NoteVault: unknown batch");
        require(TranscriptLib.verify(batchRoot, serial, proof), "NoteVault: bad proof");

        TranscriptLib.Invoice memory inv = TranscriptLib.decodeTranscript(transcript);
        bytes32 invHash = TranscriptLib.invoiceHash(inv);
        bytes32 digest = TranscriptLib.spendDigest(serial, invHash);
        require(_recover(digest, carverSig) == b.carver, "NoteVault: bad signature");
        require(inv.recipient != address(0), "NoteVault: zero recipient");

        if (_spent[serial]) {
            if (acceptedInvoiceHash[serial] == invHash) {
                // Re-broadcast of the accepted transcript: never a conviction.
                revert("ALREADY_RECONCILED");
            }
            _convict(b, serial, inv);
            return;
        }

        // First presentation.
        require(block.timestamp < b.expiry, "NoteVault: note expired");
        require(inv.amount > 0, "NoteVault: zero amount");
        uint256 remaining = _effectiveRemaining(b);
        require(inv.amount <= remaining, "NoteVault: exceeds locked value");

        _spent[serial] = true;
        acceptedInvoiceHash[serial] = invHash;
        b.remaining = remaining - inv.amount;
        _lockedOf[b.carver] -= inv.amount;
        iou.safeTransferFrom(address(this), inv.recipient, uint256(uint160(b.sarraf)), inv.amount, "");
        emit NoteReconciled(serial, inv.recipient, inv.amount);
    }

    /// @dev Conviction: seize the carver's entire remaining locked value,
    /// compensate the victim exactly the invoice amount (IOU first, insurance
    /// shortfall second), route excess to the InsuranceFund.
    function _convict(Batch storage b, bytes32 serial, TranscriptLib.Invoice memory inv) internal {
        address carver = b.carver;
        uint256 seized = _lockedOf[carver];
        _lockedOf[carver] = 0;
        // Bump the epoch: every batch carved before this instant is drained.
        seizureEpochOf[carver] += 1;

        uint256 trancheId = uint256(uint160(b.sarraf));
        uint256 comp = seized < inv.amount ? seized : inv.amount;
        if (comp > 0) {
            iou.safeTransferFrom(address(this), inv.recipient, trancheId, comp, "");
        }
        uint256 shortfall = inv.amount - comp;
        if (shortfall > 0) {
            insuranceFund.payClaimForSerial(inv.recipient, shortfall, serial);
        }
        uint256 excess = seized - comp;
        if (excess > 0) {
            iou.safeTransferFrom(address(this), address(insuranceFund), trancheId, excess, "");
            insuranceFund.recordSeizedIou(excess);
        }
        emit DoubleSpendConvicted(serial, carver, inv.recipient);
    }

    // ----------------------------------------------------------------- refund

    /// @inheritdoc INoteVault
    function refundExpired(bytes32 batchRoot) external {
        Batch storage b = _batches[batchRoot];
        require(b.carver != address(0), "NoteVault: unknown batch");
        require(block.timestamp >= b.expiry, "NoteVault: not yet expired");
        require(!b.refunded, "NoteVault: already refunded");
        uint256 remaining = _effectiveRemaining(b);
        require(remaining > 0, "NoteVault: nothing to refund");

        b.refunded = true;
        b.remaining = 0;
        _lockedOf[b.carver] -= remaining;
        iou.safeTransferFrom(address(this), b.carver, uint256(uint160(b.sarraf)), remaining, "");
        emit ExpiredRefunded(batchRoot, remaining);
    }

    // ------------------------------------------------------------- internals

    function _effectiveRemaining(Batch storage b) internal view returns (uint256) {
        if (b.refunded) return 0;
        if (b.seizureEpoch < seizureEpochOf[b.carver]) return 0; // seized
        return b.remaining;
    }

    /// @dev Raw-digest ECDSA recovery of the frozen 65-byte {r,s,v} format.
    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        require(signature.length == 65, "NoteVault: bad signature length");
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "NoteVault: malleable signature"
        );
        signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "NoteVault: invalid signer");
    }

    // ------------------------------------------------------ ERC-1155 receiver

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }
}
