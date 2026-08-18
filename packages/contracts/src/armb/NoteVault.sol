// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {INoteVault, IIouToken} from "../../../acceptance/src/interfaces/IDovizir.sol";
import {TranscriptLib} from "../../../acceptance/src/TranscriptLib.sol";

contract NoteVault is INoteVault {
    uint256 internal constant CAP = 50_000e6;

    IIouToken public immutable iouToken;

    mapping(address => uint256) public override lockedOf;
    mapping(bytes32 => bool) public override isSpent;
    mapping(bytes32 => address) public batchCarver;
    mapping(bytes32 => uint256) public batchAmount;
    mapping(bytes32 => uint64) public batchExpiry;

    constructor(address iouToken_) {
        iouToken = IIouToken(iouToken_);
    }

    function capOf(address) external pure override returns (uint256) {
        return CAP;
    }

    function carve(bytes32 batchRoot, uint256 amount, uint64 expiry) external override {
        require(lockedOf[msg.sender] + amount <= CAP, "NoteVault: over cap");
        require(batchCarver[batchRoot] == address(0), "NoteVault: batch used");
        batchCarver[batchRoot] = msg.sender;
        batchAmount[batchRoot] = amount;
        batchExpiry[batchRoot] = expiry;
        lockedOf[msg.sender] += amount;
        emit Carved(msg.sender, batchRoot, amount, expiry);
    }

    function reconcile(
        bytes32 batchRoot,
        bytes32 serial,
        bytes32[] calldata proof,
        bytes calldata transcript,
        bytes calldata carverSig
    ) external override {
        require(TranscriptLib.verify(batchRoot, serial, proof), "NoteVault: bad proof");
        address carver = batchCarver[batchRoot];
        TranscriptLib.Invoice memory inv = TranscriptLib.decodeTranscript(transcript);
        bytes32 digest = TranscriptLib.spendDigest(serial, TranscriptLib.invoiceHash(inv));
        address signer = _recoverRaw(digest, carverSig);
        require(signer == carver, "NoteVault: bad carver signature");

        if (isSpent[serial]) {
            revert("ALREADY_RECONCILED");
        }
        isSpent[serial] = true;
        uint256 payAmount = inv.amount > lockedOf[carver] ? lockedOf[carver] : inv.amount;
        lockedOf[carver] -= payAmount;
        iouToken.mint(inv.recipient, uint256(uint160(carver)), payAmount);
        emit NoteReconciled(serial, inv.recipient, payAmount);
    }

    function refundExpired(bytes32 batchRoot) external override {
        require(batchCarver[batchRoot] == msg.sender, "NoteVault: not owner");
        require(block.timestamp >= batchExpiry[batchRoot], "NoteVault: not expired");
        uint256 remaining = batchAmount[batchRoot];
        batchAmount[batchRoot] = 0;
        if (remaining > 0 && remaining <= lockedOf[msg.sender]) {
            lockedOf[msg.sender] -= remaining;
        }
        emit ExpiredRefunded(batchRoot, remaining);
    }

    function _recoverRaw(bytes32 digest, bytes calldata signature) private pure returns (address) {
        require(signature.length == 65, "NoteVault: bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        return ecrecover(digest, v, r, s);
    }
}
