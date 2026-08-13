/**
 * Byte / hex primitives shared across the library. Wire rules (frozen):
 * keccak-256 hashing, uint32-be batch indices, uint256-be note values,
 * lowercase 0x-hex byte strings.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";
import type { Hex } from "./types.js";

export { concatBytes, keccak_256 };

/** Any 0x-hex string (the canonicalize lowercasing class). */
export const HEX_STRING_RE = /^0x[0-9a-fA-F]+$/;

export const strip0x = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h);

export const toHex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;

export function fromHex(h: string): Uint8Array {
  return hexToBytes(strip0x(h));
}

/** Lowercase-normalized hex passthrough for byte fields we emit. */
export function normHex(h: string): Hex {
  if (!isHexBytes(h)) throw new Error(`invalid hex byte string: ${String(h)}`);
  return h.toLowerCase() as Hex;
}

/** True iff `v` is a 0x-hex string encoding whole bytes (even nibble count). */
export function isHexBytes(v: unknown, byteLength?: number): v is Hex {
  if (typeof v !== "string" || !HEX_STRING_RE.test(v) || v.length % 2 !== 0) return false;
  return byteLength === undefined || v.length === 2 + 2 * byteLength;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export const keccakHex = (b: Uint8Array): Hex => toHex(keccak_256(b));

export function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`u32be: out of range: ${n}`);
  }
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export function u256be(v: bigint): Uint8Array {
  if (typeof v !== "bigint" || v < 0n || v >= 1n << 256n) {
    throw new Error(`u256be: out of range: ${String(v)}`);
  }
  return hexToBytes(v.toString(16).padStart(64, "0"));
}

export function randomHex(byteLength: number): Hex {
  const b = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}
