// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TranscriptLib} from "../src/TranscriptLib.sol";

/// Self-tests for the FROZEN transcript spec helpers (src/TranscriptLib.sol).
/// These exercise no arm code and MUST pass standalone: they guarantee the
/// referee's own merkle/encoding math is sound before it judges either arm.
contract TranscriptLibTest is Test {
    function _serials(uint256 n, bytes32 salt) internal pure returns (bytes32[] memory s) {
        s = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            s[i] = keccak256(abi.encode(salt, i));
        }
    }

    /// A single-serial batch: root == leaf, empty proof verifies.
    function test_merkle_singleSerialBatch() public pure {
        bytes32[] memory s = _serials(1, "one");
        bytes32 root = TranscriptLib.computeRoot(s);
        assertEq(root, TranscriptLib.leaf(s[0]), "singleton root is the leaf");
        assertTrue(TranscriptLib.verify(root, s[0], new bytes32[](0)));
    }

    /// computeProof round-trips through verify for every index of every batch
    /// size 1..8 (covers even, odd, and promoted-node shapes).
    function test_merkle_proofRoundTrip_allSizesUpToEight() public pure {
        for (uint256 n = 1; n <= 8; ++n) {
            bytes32[] memory s = _serials(n, bytes32(n));
            bytes32 root = TranscriptLib.computeRoot(s);
            for (uint256 i; i < n; ++i) {
                assertTrue(
                    TranscriptLib.verify(root, s[i], TranscriptLib.computeProof(s, i)),
                    "every member must verify against its own proof"
                );
            }
        }
    }

    /// A serial outside the batch never verifies with any in-batch proof.
    function test_merkle_foreignSerialNeverVerifies() public pure {
        bytes32[] memory s = _serials(5, "batch");
        bytes32 root = TranscriptLib.computeRoot(s);
        bytes32 foreign = keccak256("foreign");
        for (uint256 i; i < 5; ++i) {
            assertFalse(TranscriptLib.verify(root, foreign, TranscriptLib.computeProof(s, i)));
        }
    }

    /// Fuzz: round-trip holds for arbitrary batch sizes and indices.
    function testFuzz_merkle_proofRoundTrip(uint256 n, uint256 index, bytes32 salt) public pure {
        n = bound(n, 1, 32);
        index = bound(index, 0, n - 1);
        bytes32[] memory s = _serials(n, salt);
        bytes32 root = TranscriptLib.computeRoot(s);
        assertTrue(TranscriptLib.verify(root, s[index], TranscriptLib.computeProof(s, index)));
    }

    /// Transcript encode/decode round-trip preserves the invoice, and the
    /// invoice hash commits to every field (recipient, amount, nonce).
    function testFuzz_transcript_encodeDecodeRoundTrip(address recipient, uint256 amount, bytes32 nonce)
        public
        pure
    {
        TranscriptLib.Invoice memory inv =
            TranscriptLib.Invoice({recipient: recipient, amount: amount, nonce: nonce});
        TranscriptLib.Invoice memory back =
            TranscriptLib.decodeTranscript(TranscriptLib.encodeTranscript(inv));
        assertEq(back.recipient, inv.recipient);
        assertEq(back.amount, inv.amount);
        assertEq(back.nonce, inv.nonce);

        // hash commits to each field
        bytes32 h = TranscriptLib.invoiceHash(inv);
        inv.amount = amount ^ 1;
        assertTrue(TranscriptLib.invoiceHash(inv) != h, "amount is committed");
        inv.amount = amount;
        inv.nonce = ~nonce;
        assertTrue(TranscriptLib.invoiceHash(inv) != h, "nonce is committed");
    }

    /// The spend digest binds serial, invoice, expiry AND batchRoot — any
    /// change alters it (§5 amendment adds expiry + batchRoot binding).
    function test_spendDigest_bindsSerialInvoiceExpiryAndRoot() public pure {
        TranscriptLib.Invoice memory inv =
            TranscriptLib.Invoice({recipient: address(0xBEEF), amount: 1e6, nonce: "n"});
        bytes32 ih = TranscriptLib.invoiceHash(inv);
        uint64 exp = 1000;
        bytes32 root = keccak256("root-1");
        bytes32 d = TranscriptLib.spendDigest("serial-1", ih, exp, root);
        assertTrue(TranscriptLib.spendDigest("serial-2", ih, exp, root) != d, "serial is bound");
        inv.recipient = address(0xCAFE);
        assertTrue(
            TranscriptLib.spendDigest("serial-1", TranscriptLib.invoiceHash(inv), exp, root) != d,
            "recipient binding: invoice is bound"
        );
        assertTrue(TranscriptLib.spendDigest("serial-1", ih, exp + 1, root) != d, "expiry is bound");
        assertTrue(
            TranscriptLib.spendDigest("serial-1", ih, exp, keccak256("root-2")) != d, "batchRoot is bound"
        );
    }
}
