/**
 * secp256k1 key and signature primitives. Frozen signature scheme:
 * 64-byte compact r‖s, RFC6979 deterministic, low-s (noble defaults),
 * always over a 32-byte keccak-256 digest — no extra hashing inside sign.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { fromHex, isHexBytes, keccak_256, strip0x, toHex } from "./bytes.js";
import type { Hex, KeyPair } from "./types.js";

export function generateKeyPair(seed?: Hex): KeyPair {
  let priv: Uint8Array;
  if (seed !== undefined) {
    if (!isHexBytes(seed)) throw new Error("generateKeyPair: seed must be a 0x-hex byte string");
    // Deterministic seed -> scalar mapping (deliberately unpinned by the
    // referee): iterate keccak-256 until the candidate is a valid scalar.
    let candidate = keccak_256(fromHex(seed));
    while (!secp256k1.utils.isValidPrivateKey(candidate)) {
      candidate = keccak_256(candidate);
    }
    priv = candidate;
  } else {
    priv = secp256k1.utils.randomPrivateKey();
  }
  return {
    privateKey: toHex(priv),
    publicKey: toHex(secp256k1.getPublicKey(priv, true)),
  };
}

/** RFC6979 deterministic, low-s, 64-byte compact r‖s over a raw digest. */
export function signDigest(privateKey: Hex, digest: Uint8Array): Hex {
  return `0x${secp256k1.sign(digest, strip0x(privateKey)).toCompactHex()}`;
}

/** True iff `sig` is a valid (low-s) compact signature over `digest` by `pub`. */
export function verifyDigest(sig: string, digest: Uint8Array, pub: string): boolean {
  try {
    return secp256k1.verify(fromHex(sig), digest, fromHex(pub));
  } catch {
    return false;
  }
}

/** True iff `pub` is a 33-byte compressed point on the curve. */
export function isCompressedPoint(pub: unknown): pub is Hex {
  if (!isHexBytes(pub, 33)) return false;
  try {
    secp256k1.ProjectivePoint.fromHex(strip0x(pub)).assertValidity();
    return true;
  } catch {
    return false;
  }
}
