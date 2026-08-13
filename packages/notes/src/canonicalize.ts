/**
 * The deterministic JSON wire format (frozen header of notes-api.d.ts plus
 * referee pins 1–3):
 *  - UTF-8 output, hashed/signed over the UTF-8 bytes of this serialization;
 *  - object keys sorted lexicographically, recursively;
 *  - bigints as minimal lowercase 0x-hex strings (0n -> "0x0");
 *  - strings matching ^0x[0-9a-fA-F]+$ are lowercased (byte fields);
 *  - other strings serialize per JSON.stringify with raw UTF-8 (no \u
 *    escaping of non-ASCII);
 *  - undefined-valued keys are omitted (no null placeholders).
 */
import { HEX_STRING_RE, keccakHex, utf8 } from "./bytes.js";
import type { Hex } from "./types.js";

export function canonicalize(value: unknown): string {
  if (typeof value === "bigint") {
    const abs = value < 0n ? undefined : value.toString(16);
    if (abs === undefined) throw new Error("canonicalize: negative bigint has no wire form");
    return JSON.stringify(`0x${abs}`);
  }
  if (typeof value === "string") {
    return JSON.stringify(HEX_STRING_RE.test(value) ? value.toLowerCase() : value);
  }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalize: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalize: unsupported value of type ${typeof value}`);
}

/** keccak256 over the UTF-8 bytes of the canonical serialization. */
export function hashCanonical(value: unknown): Hex {
  return keccakHex(utf8(canonicalize(value)));
}
