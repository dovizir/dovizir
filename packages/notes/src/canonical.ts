/**
 * Deterministic serialization + byte/hex primitives.
 *
 * Wire format (pinned): UTF-8, object keys sorted lexicographically, bigints as
 * minimal 0x-hex strings (`0n` -> `"0x0"`), byte fields as 0x-hex, hex lowercased,
 * absent optionals omitted entirely.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import type { Hex } from "./types";

const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;

export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && HEX_PATTERN.test(value);
}

export function toHex(bytes: Uint8Array): Hex {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return `0x${out}`;
}

export function fromHex(value: Hex): Uint8Array {
  const body = value.slice(2);
  if (body.length % 2 !== 0) throw new Error("MALFORMED");
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("MALFORMED");
    out[i] = byte;
  }
  return out;
}

/** Minimal lowercase hex for a non-negative bigint: `0n` -> `"0x0"`. */
export function bigintToHex(value: bigint): Hex {
  if (value < 0n) throw new Error("MALFORMED");
  return `0x${value.toString(16)}`;
}

/** Big-endian 32-byte encoding, as the merkle leaves bind values. */
export function u256(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("MALFORMED");
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function keccak256(...parts: readonly Uint8Array[]): Hex {
  return toHex(keccak_256(concatBytes(parts)));
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** The deterministic JSON serializer the whole wire format is defined against. */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return JSON.stringify(bigintToHex(value));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("MALFORMED");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(isHex(value) ? value.toLowerCase() : value);
  }
  if (value instanceof Uint8Array) return JSON.stringify(toHex(value));
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter((entry) => entry[1] !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const body = entries
      .map((entry) => `${JSON.stringify(entry[0])}:${canonicalize(entry[1])}`)
      .join(",");
    return `{${body}}`;
  }
  throw new Error("MALFORMED");
}
