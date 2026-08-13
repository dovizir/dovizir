/**
 * Referee-side crypto helpers. Everything here is built on @noble directly so
 * expected values are computed independently of the implementation under test.
 * Pinned wire rules encoded here (see README "Pinned interpretations"):
 *  - keccak-256 for all hashing
 *  - uint32-be for batch indices, uint256-be for note values
 *  - merkle interior nodes: commutative sorted-pair keccak (OZ MerkleProof style)
 *  - signatures: 64-byte compact r||s, RFC6979 deterministic, low-s
 *  - canonical JSON: keys sorted recursively, bigint -> minimal 0x-hex,
 *    0x-hex byte strings lowercased, undefined-valued keys omitted, raw UTF-8
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";
import type { Hex, KeyPair } from "@dovizir/notes";

export { concatBytes, keccak_256, secp256k1 };

export const strip0x = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h);
export const toHex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}` as Hex;
export const fromHex = (h: string): Uint8Array => hexToBytes(strip0x(h));
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const keccakHex = (b: Uint8Array): Hex => toHex(keccak_256(b));

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export function u64be(n: number): Uint8Array {
  return hexToBytes(BigInt(n).toString(16).padStart(16, "0"));
}

export function u256be(v: bigint): Uint8Array {
  return hexToBytes(v.toString(16).padStart(64, "0"));
}

/** Build a KeyPair literal with noble — deliberately NOT via generateKeyPair,
 * so fixtures/goldens are independent of the arm's seed-derivation choice. */
export function keyFromPriv(priv: Hex): KeyPair {
  return {
    privateKey: priv,
    publicKey: toHex(secp256k1.getPublicKey(strip0x(priv), true)),
  };
}

/** RFC6979 deterministic, low-s, 64-byte compact r||s. */
export function signDigest(priv: Hex, digest: Uint8Array): Hex {
  return `0x${secp256k1.sign(digest, strip0x(priv)).toCompactHex()}` as Hex;
}

export function sigValid(sig: string, digest: Uint8Array, pub: string): boolean {
  try {
    return secp256k1.verify(strip0x(sig), digest, strip0x(pub));
  } catch {
    return false;
  }
}

export function isValidCompressedPoint(pub: string): boolean {
  try {
    const p = secp256k1.ProjectivePoint.fromHex(strip0x(pub));
    p.assertValidity();
    return strip0x(pub).length === 66;
  } catch {
    return false;
  }
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/** Commutative sorted-pair keccak — OpenZeppelin MerkleProof compatible. */
export function pairHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  return cmpBytes(a, b) <= 0
    ? keccak_256(concatBytes(a, b))
    : keccak_256(concatBytes(b, a));
}

export const leafOf = (serial: string, value: bigint): Uint8Array =>
  keccak_256(concatBytes(fromHex(serial), u256be(value)));

export function foldProof(leaf: Uint8Array, proof: readonly string[]): Uint8Array {
  return proof.reduce((acc, sib) => pairHash(acc, fromHex(sib)), leaf);
}

export function merkleVerifies(
  serial: string,
  value: bigint,
  proof: readonly string[],
  root: string,
): boolean {
  return toHex(foldProof(leafOf(serial, value), proof)) === root.toLowerCase();
}

const HEX_STRING_RE = /^0x[0-9a-fA-F]+$/;

/** Reference canonical JSON serializer (the referee's reading of the frozen
 * wire-format rules). Used to build EXPECTED strings; never fed impl output. */
export function refCanonical(v: unknown): string {
  if (typeof v === "bigint") return JSON.stringify(`0x${v.toString(16)}`);
  if (typeof v === "string")
    return JSON.stringify(HEX_STRING_RE.test(v) ? v.toLowerCase() : v);
  if (v === null || typeof v === "number" || typeof v === "boolean")
    return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(refCanonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${refCanonical(o[k])}`).join(",")}}`;
  }
  throw new Error(`refCanonical: unsupported value of type ${typeof v}`);
}

/** Deep copy (bigint-safe) so tests can tamper without mutating fixtures. */
export const clone = <T>(v: T): T => structuredClone(v);

export function flipLastByte(h: Hex): Hex {
  const b = fromHex(h);
  b[b.length - 1] ^= 0xff;
  return toHex(b);
}
