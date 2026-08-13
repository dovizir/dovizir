/**
 * Area 3 — carveBatch: serial derivation, merkle commitments, reproducibility.
 * Pinned rules:
 *   serial_i = keccak256(batchSalt ‖ uint32-be(i))
 *   leaf_i   = keccak256(serial_i ‖ uint256-be(value_i))
 *   interior = commutative sorted-pair keccak (OZ MerkleProof compatible)
 *   single-note batch: batchRoot == leaf, proof == []
 */
import { describe, expect, it } from "vitest";
import {
  concatBytes,
  fromHex,
  keccakHex,
  leafOf,
  merkleVerifies,
  toHex,
  u32be,
} from "./support/helpers";
import {
  CARVER,
  DENOMS,
  NOTE_EXPIRY,
  SALT,
  TRANCHE,
  makeBatch,
} from "./support/fixtures";

describe("carveBatch: batch structure", () => {
  const batch = makeBatch();

  it("carves exactly one note per denomination, in order", () => {
    expect(batch.notes.length).toBe(DENOMS.length);
    batch.notes.forEach((n, i) => {
      expect(n.index).toBe(i);
      expect(n.value).toBe(DENOMS[i]);
    });
  });

  it("echoes carver public key, trancheId, expiry, and injected batchSalt", () => {
    expect(batch.carver.toLowerCase()).toBe(CARVER.publicKey);
    expect(batch.trancheId.toLowerCase()).toBe(TRANCHE);
    expect(batch.expiry).toBe(NOTE_EXPIRY);
    expect(batch.batchSalt.toLowerCase()).toBe(SALT);
  });
});

describe("carveBatch: serial derivation", () => {
  const batch = makeBatch();

  it("serial_i == keccak256(batchSalt ‖ index-as-uint32-be)", () => {
    batch.notes.forEach((n, i) => {
      const expected = keccakHex(concatBytes(fromHex(SALT), u32be(i)));
      expect(n.serial.toLowerCase()).toBe(expected);
    });
  });

  it("serials are unique across the batch even for equal denominations", () => {
    const serials = new Set(batch.notes.map((n) => n.serial.toLowerCase()));
    expect(serials.size).toBe(batch.notes.length);
    expect(batch.notes[0].value).toBe(batch.notes[1].value); // fixture guarantees the collision chance
  });
});

describe("carveBatch: merkle commitments", () => {
  const batch = makeBatch();

  it("every note's proof verifies against batchRoot for leaf keccak256(serial ‖ value-as-uint256-be)", () => {
    for (const n of batch.notes) {
      expect(merkleVerifies(n.serial, n.value, n.proof, batch.batchRoot)).toBe(true);
    }
  });

  it("proofs bind the value: a different value fails the same proof", () => {
    const n = batch.notes[0];
    expect(merkleVerifies(n.serial, n.value + 1n, n.proof, batch.batchRoot)).toBe(false);
  });

  it("proofs bind the serial: a different serial fails the same proof", () => {
    const [a, b] = batch.notes;
    expect(merkleVerifies(b.serial, a.value, a.proof, batch.batchRoot)).toBe(false);
  });

  it("a single-note batch commits batchRoot == leaf with an empty proof", () => {
    const single = makeBatch({ denominations: [5_000_000n] });
    const n = single.notes[0];
    expect(n.proof).toEqual([]);
    expect(single.batchRoot.toLowerCase()).toBe(toHex(leafOf(n.serial, n.value)));
  });
});

describe("carveBatch: reproducibility", () => {
  it("identical inputs (same injected salt) reproduce identical root, serials, and proofs", () => {
    const a = makeBatch();
    const b = makeBatch();
    expect(b.batchRoot).toBe(a.batchRoot);
    expect(b.notes.map((n) => n.serial)).toEqual(a.notes.map((n) => n.serial));
    expect(b.notes.map((n) => n.proof)).toEqual(a.notes.map((n) => n.proof));
  });

  it("a different salt changes every serial and the root", () => {
    const a = makeBatch();
    const b = makeBatch({ batchSalt: `0x${"00".repeat(32)}` as typeof SALT });
    expect(b.batchRoot).not.toBe(a.batchRoot);
    b.notes.forEach((n, i) => expect(n.serial).not.toBe(a.notes[i].serial));
  });
});
