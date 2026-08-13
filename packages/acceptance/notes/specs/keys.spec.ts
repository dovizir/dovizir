/**
 * Area 2 — generateKeyPair: deterministic from seed, valid compressed
 * secp256k1 points, distinct without seed.
 * NOT pinned: the seed -> private-scalar mapping (only its determinism).
 */
import { describe, expect, it } from "vitest";
import { generateKeyPair, type Hex } from "@dovizir/notes";
import { isValidCompressedPoint, secp256k1, strip0x } from "./support/helpers";

const SEED = `0x${"ab".repeat(32)}` as Hex;
const OTHER_SEED = `0x${"cd".repeat(32)}` as Hex;

describe("generateKeyPair", () => {
  it("is deterministic for the same seed", () => {
    const a = generateKeyPair(SEED);
    const b = generateKeyPair(SEED);
    expect(a.privateKey).toBe(b.privateKey);
    expect(a.publicKey).toBe(b.publicKey);
  });

  it("derives different keys from different seeds", () => {
    expect(generateKeyPair(SEED).privateKey).not.toBe(
      generateKeyPair(OTHER_SEED).privateKey,
    );
  });

  it("returns a 32-byte private scalar and a 33-byte compressed public point", () => {
    const kp = generateKeyPair(SEED);
    expect(kp.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(kp.publicKey).toMatch(/^0x0[23][0-9a-f]{64}$/);
    expect(isValidCompressedPoint(kp.publicKey)).toBe(true);
  });

  it("publicKey is the secp256k1 point of privateKey (noble cross-check)", () => {
    const kp = generateKeyPair(SEED);
    const expected = secp256k1.getPublicKey(strip0x(kp.privateKey), true);
    expect(strip0x(kp.publicKey)).toBe(Buffer.from(expected).toString("hex"));
  });

  it("without a seed, generates distinct valid key pairs per call", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(isValidCompressedPoint(a.publicKey)).toBe(true);
    expect(isValidCompressedPoint(b.publicKey)).toBe(true);
  });
});
