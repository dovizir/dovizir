// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TranscriptLib — canonical NoteVault spend-transcript encoding (FROZEN SPEC)
/// @notice Part of the frozen referee spec: both arms' NoteVault
/// implementations MUST verify exactly this encoding (PROTOCOL.md §1; the
/// interface comment on INoteVault.reconcile). It is deliberately minimal and
/// EVM-idiomatic; it MAY differ from the "dovizir/notes" TS wire format —
/// NoteVault verifies its own on-chain encoding.
///
/// Definitions:
///  - Invoice: the recipient-binding commitment. `recipient` is the payee the
///    note is bound to, `amount` the value (mock-USDT-denominated IOU units,
///    6 decimals), `nonce` a recipient-chosen 32-byte value.
///  - invoiceHash = keccak256(abi.encode(INVOICE_TYPEHASH, recipient, amount, nonce))
///  - spendDigest = keccak256(abi.encodePacked(serial, invoiceHash))
///  - carverSig  = 65-byte {r,s,v} ECDSA signature by the carver over
///    spendDigest (RAW digest — no EIP-191/EIP-712 prefix; tests sign with
///    vm.sign(pk, spendDigest)).
///  - transcript = abi.encode(recipient, amount, nonce)  (the serial travels
///    separately as reconcile's `serial` argument).
///  - Merkle batch commitment: leaf = keccak256(abi.encodePacked(serial));
///    interior node = keccak256(sorted-pair concat) (OpenZeppelin
///    MerkleProof-compatible); odd trailing node is promoted unchanged.
library TranscriptLib {
    struct Invoice {
        address recipient;
        uint256 amount;
        bytes32 nonce;
    }

    bytes32 internal constant INVOICE_TYPEHASH =
        keccak256("DovizirInvoice(address recipient,uint256 amount,bytes32 nonce)");

    // ----------------------------------------------------------------- hashing

    function invoiceHash(Invoice memory inv) internal pure returns (bytes32) {
        return keccak256(abi.encode(INVOICE_TYPEHASH, inv.recipient, inv.amount, inv.nonce));
    }

    function spendDigest(bytes32 serial, bytes32 invoiceHash_) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(serial, invoiceHash_));
    }

    // ---------------------------------------------------------------- encoding

    function encodeTranscript(Invoice memory inv) internal pure returns (bytes memory) {
        return abi.encode(inv.recipient, inv.amount, inv.nonce);
    }

    function decodeTranscript(bytes memory transcript) internal pure returns (Invoice memory inv) {
        (inv.recipient, inv.amount, inv.nonce) = abi.decode(transcript, (address, uint256, bytes32));
    }

    // ------------------------------------------------------------------ merkle

    function leaf(bytes32 serial) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(serial));
    }

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// Verify `serial` ∈ batch committed by `root`. This is the verification
    /// NoteVault MUST perform for reconcile's (serial, proof) arguments.
    function verify(bytes32 root, bytes32 serial, bytes32[] memory proof) internal pure returns (bool) {
        bytes32 node = leaf(serial);
        for (uint256 i; i < proof.length; ++i) {
            node = hashPair(node, proof[i]);
        }
        return node == root;
    }

    /// Build the batch root over an ordered list of serials (test-side helper;
    /// arms may reuse it in scripts/tooling).
    function computeRoot(bytes32[] memory serials) internal pure returns (bytes32) {
        require(serials.length > 0, "TranscriptLib: empty batch");
        bytes32[] memory level = new bytes32[](serials.length);
        for (uint256 i; i < serials.length; ++i) {
            level[i] = leaf(serials[i]);
        }
        while (level.length > 1) {
            level = _nextLevel(level);
        }
        return level[0];
    }

    /// Membership proof for serials[index], consistent with computeRoot/verify.
    function computeProof(bytes32[] memory serials, uint256 index)
        internal
        pure
        returns (bytes32[] memory proof)
    {
        require(index < serials.length, "TranscriptLib: index oob");
        bytes32[] memory level = new bytes32[](serials.length);
        for (uint256 i; i < serials.length; ++i) {
            level[i] = leaf(serials[i]);
        }
        bytes32[] memory scratch = new bytes32[](64);
        uint256 n;
        while (level.length > 1) {
            uint256 sibling = index ^ 1;
            if (sibling < level.length) {
                scratch[n++] = level[sibling];
            }
            level = _nextLevel(level);
            index /= 2;
        }
        proof = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            proof[i] = scratch[i];
        }
    }

    function _nextLevel(bytes32[] memory level) private pure returns (bytes32[] memory next) {
        uint256 len = level.length;
        next = new bytes32[]((len + 1) / 2);
        for (uint256 i; i < len / 2; ++i) {
            next[i] = hashPair(level[2 * i], level[2 * i + 1]);
        }
        if (len % 2 == 1) {
            next[next.length - 1] = level[len - 1];
        }
    }
}
