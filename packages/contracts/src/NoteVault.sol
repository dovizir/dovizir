// SPDX-License-Identifier: BUSL-1.1
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
/// Double-spend handling (frozen spec addition #6; hardened 2026-08-13 after
/// adversarial review — see docs/experiment/REVIEW-FINDINGS-M1.md):
///  - a second CARVER-SIGNED transcript for a spent serial with a different
///    invoice convicts: the carver's remaining locked value IN THE CONVICTED
///    BATCH'S TRANCHE is seized, the victim is made whole for at most the
///    serial's ORIGINAL first-spend amount (carver-tranche IOU first, then USDT
///    via InsuranceFund.payClaim for any shortfall), and seizure excess goes to
///    the InsuranceFund under its 50/50 split bookkeeping;
///  - a byte-identical resubmission is NOT a double-spend: it reverts with
///    ALREADY_RECONCILED (canonical behavior);
///  - a serial can be convicted AT MOST ONCE: a second conviction attempt on an
///    already-convicted serial reverts (ALREADY_CONVICTED) — this closes the
///    unbounded-drain replay and the reentrancy-amplification findings;
///  - a conflicting transcript NOT signed by the carver reverts without
///    conviction.
///
/// FIX #1 (amount bound): the payout on the spent-serial branch is capped at
/// `firstSpendAmount[serial]` — what the note was actually worth at first
/// spend — so a carver-chosen conviction invoice amount can never drive the
/// compensation.
///
/// FIX #4 (tranche-scoped seizure): locked value and the seizure epoch are
/// tracked per (carver, tranche) rather than aggregated. A conviction seizes
/// and zeroes only the convicted batch's tranche, so it can never revert for
/// lack of balance in an unrelated tranche, and refundExpired still returns
/// untouched tranches' value. Cross-tranche seizure within one tranche stays
/// O(1) via the per-(carver,tranche) epoch: each batch records that epoch at
/// carve time; a conviction bumps it, instantly zeroing every pre-existing
/// batch in the same tranche without enumeration.
///
/// FIX #3 (CEI + guard): _convict performs all state writes (convicted flag,
/// epoch bump, locked bookkeeping) BEFORE any external call, and reconcile is
/// non-reentrant.
contract NoteVault is INoteVault {
    // ------------------------------------------------------------- constants
    /// M1 uniform base cap (referee floor: >= 50_000e6).
    uint256 public constant BASE_CAP = 100_000e6;

    // --------------------------------------------------------------- storage
    struct Batch {
        address carver;
        address sarraf; // sponsor at carve time — the locked tranche
        uint64 expiry;
        uint64 seizureEpoch; // (carver,tranche) epoch when carved
        bool refunded;
        uint256 remaining; // raw remainder; effective 0 if epoch is stale
    }

    IouToken public immutable iou;
    IMemberRegistry public immutable memberRegistry;
    InsuranceFund public immutable insuranceFund;

    mapping(bytes32 => Batch) internal _batches;
    /// Aggregate locked value per member (across all tranches): backs the cap
    /// check and the lockedOf view.
    mapping(address => uint256) internal _lockedOf;
    /// FIX #4: locked value per (carver, tranche) — the seizure unit.
    mapping(address => mapping(address => uint256)) internal _lockedInTranche;
    /// FIX #4: seizure epoch per (carver, tranche). A conviction bumps only the
    /// convicted tranche's epoch, leaving other tranches spendable/refundable.
    mapping(address => mapping(address => uint64)) public seizureEpochOf;
    mapping(bytes32 => bool) internal _spent;
    /// serial => invoiceHash accepted at first presentation (byte-identity key).
    mapping(bytes32 => bytes32) public acceptedInvoiceHash;
    /// FIX #1: serial => amount paid out at its FIRST spend — the ceiling on any
    /// double-spend compensation for that serial.
    mapping(bytes32 => uint256) public firstSpendAmount;
    /// FIX #2: serial => already convicted. A convicted serial can never be
    /// convicted again (anti-replay).
    mapping(bytes32 => bool) public convicted;

    /// FIX #3: minimal non-reentrancy guard (paris EVM — storage, not transient).
    uint256 private _entered;

    modifier nonReentrant() {
        require(_entered == 0, "NoteVault: reentrant");
        _entered = 1;
        _;
        _entered = 0;
    }

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
            seizureEpoch: seizureEpochOf[msg.sender][sarraf],
            refunded: false,
            remaining: amount
        });
        _lockedOf[msg.sender] += amount;
        _lockedInTranche[msg.sender][sarraf] += amount;
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
    ) external nonReentrant {
        Batch storage b = _batches[batchRoot];
        require(b.carver != address(0), "NoteVault: unknown batch");
        require(TranscriptLib.verify(batchRoot, serial, proof), "NoteVault: bad proof");

        TranscriptLib.Invoice memory inv = TranscriptLib.decodeTranscript(transcript);
        bytes32 invHash = TranscriptLib.invoiceHash(inv);
        // FIX #5: expiry + batchRoot are signed into the digest, so the carver's
        // signature binds the batch this spend belongs to (proof stays unsigned —
        // it is checked against the now-signed batchRoot).
        bytes32 digest = TranscriptLib.spendDigest(serial, invHash, b.expiry, batchRoot);
        require(_recover(digest, carverSig) == b.carver, "NoteVault: bad signature");
        require(inv.recipient != address(0), "NoteVault: zero recipient");

        if (_spent[serial]) {
            if (acceptedInvoiceHash[serial] == invHash) {
                // Re-broadcast of the accepted transcript: never a conviction.
                revert("ALREADY_RECONCILED");
            }
            // FIX #2: a serial is convicted at most once.
            require(!convicted[serial], "ALREADY_CONVICTED");
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
        firstSpendAmount[serial] = inv.amount; // FIX #1: record the note's worth
        b.remaining = remaining - inv.amount;
        _lockedOf[b.carver] -= inv.amount;
        _lockedInTranche[b.carver][b.sarraf] -= inv.amount;
        iou.safeTransferFrom(address(this), inv.recipient, uint256(uint160(b.sarraf)), inv.amount, "");
        emit NoteReconciled(serial, inv.recipient, inv.amount);
    }

    /// @dev Conviction: seize the carver's remaining locked value IN THE
    /// CONVICTED BATCH'S TRANCHE (FIX #4), compensate the victim at most the
    /// serial's original first-spend amount (FIX #1) — IOU first, insurance
    /// shortfall second — and route excess to the InsuranceFund. All state
    /// writes precede every external call (FIX #3, CEI).
    function _convict(Batch storage b, bytes32 serial, TranscriptLib.Invoice memory inv) internal {
        address carver = b.carver;
        address sarraf = b.sarraf;

        // FIX #1: the victim of a double-spend is owed at most what the note was
        // worth at its first spend — never a carver-chosen conviction amount.
        uint256 owed = inv.amount;
        uint256 recorded = firstSpendAmount[serial];
        if (owed > recorded) owed = recorded;

        // FIX #4: seize only this (carver, tranche)'s locked value.
        uint256 seized = _lockedInTranche[carver][sarraf];
        uint256 comp = seized < owed ? seized : owed;
        uint256 shortfall = owed - comp;
        uint256 excess = seized - comp;

        // ---- FIX #3: state writes BEFORE any external call ----
        convicted[serial] = true; // FIX #2: anti-replay
        _lockedInTranche[carver][sarraf] = 0;
        _lockedOf[carver] -= seized;
        seizureEpochOf[carver][sarraf] += 1; // zero every batch in this tranche

        // ---- external calls AFTER state ----
        uint256 trancheId = uint256(uint160(sarraf));
        if (comp > 0) {
            iou.safeTransferFrom(address(this), inv.recipient, trancheId, comp, "");
        }
        if (shortfall > 0) {
            insuranceFund.payClaimForSerial(inv.recipient, shortfall, serial);
        }
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
        _lockedInTranche[b.carver][b.sarraf] -= remaining;
        iou.safeTransferFrom(address(this), b.carver, uint256(uint160(b.sarraf)), remaining, "");
        emit ExpiredRefunded(batchRoot, remaining);
    }

    // ------------------------------------------------------------- internals

    function _effectiveRemaining(Batch storage b) internal view returns (uint256) {
        if (b.refunded) return 0;
        if (b.seizureEpoch < seizureEpochOf[b.carver][b.sarraf]) return 0; // tranche seized
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
