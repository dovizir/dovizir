/**
 * Area 1 — canonicalize / hashInvoice: the deterministic JSON wire format.
 * Rules under test (frozen header of notes-api.d.ts):
 *   UTF-8, object keys sorted lexicographically (recursively), bigints as
 *   0x-hex strings, byte fields as lowercase 0x-hex; hashes are keccak-256
 *   over the UTF-8 bytes of the canonical serialization.
 */
import { describe, expect, it } from "vitest";
import { canonicalize, hashInvoice, type Invoice } from "@dovizir/notes";
import { keccakHex, utf8 } from "./support/helpers";
import { RECIPIENT } from "./support/fixtures";

describe("canonicalize: deterministic JSON serializer", () => {
  it("sorts object keys lexicographically", () => {
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it("sorts keys recursively in nested objects", () => {
    expect(canonicalize({ b: { d: 2, c: 1 }, a: 0 })).toBe(
      '{"a":0,"b":{"c":1,"d":2}}',
    );
  });

  it("serializes bigints as minimal lowercase 0x-hex strings", () => {
    expect(canonicalize({ v: 123456n })).toBe('{"v":"0x1e240"}');
  });

  it("serializes bigint zero as \"0x0\"", () => {
    // PINNED: minimal hex, so 0n -> "0x0" (not "0x00" or "0x")
    expect(canonicalize({ v: 0n })).toBe('{"v":"0x0"}');
  });

  it("passes byte fields through as lowercase 0x-hex", () => {
    expect(canonicalize({ sig: "0xDEADbeef" })).toBe('{"sig":"0xdeadbeef"}');
  });

  it("preserves array element order (proofs are positional)", () => {
    expect(canonicalize({ proof: ["0xbb", "0xaa"] })).toBe(
      '{"proof":["0xbb","0xaa"]}',
    );
  });

  it("emits non-ASCII strings as raw UTF-8 (no \\u escaping) so bytes are stable", () => {
    expect(canonicalize({ memo: "tea ☕ چای" })).toBe('{"memo":"tea ☕ چای"}');
  });

  it("produces byte-identical output for key-order permutations of the same object", () => {
    const a = canonicalize({ x: 1n, y: "0xAB", z: [1, 2] });
    const b = canonicalize({ z: [1, 2], y: "0xab", x: 1n });
    expect(a).toBe(b);
  });
});

describe("hashInvoice: keccak256 over canonical UTF-8 bytes", () => {
  const invoice: Invoice = {
    recipient: RECIPIENT.publicKey,
    amount: 5_000_000n,
    nonce: `0x${"0badc0de".repeat(8)}` as Invoice["nonce"],
    memo: "tea ☕",
    createdAt: 1_776_999_700,
  };

  it("equals noble keccak_256 of a hand-built canonical string", () => {
    // Hand-assembled — sorted keys: amount, createdAt, memo, nonce, recipient.
    const handBuilt =
      `{"amount":"0x4c4b40"` +
      `,"createdAt":1776999700` +
      `,"memo":"tea ☕"` +
      `,"nonce":"0x${"0badc0de".repeat(8)}"` +
      `,"recipient":"${RECIPIENT.publicKey.toLowerCase()}"}`;
    expect(canonicalize(invoice)).toBe(handBuilt);
    expect(hashInvoice(invoice)).toBe(keccakHex(utf8(handBuilt)));
  });

  it("is internally consistent: hashInvoice == keccak256(utf8(canonicalize(invoice)))", () => {
    expect(hashInvoice(invoice)).toBe(keccakHex(utf8(canonicalize(invoice))));
  });

  it("omits an absent optional memo from the canonical form", () => {
    // PINNED: optional/undefined fields are omitted, not serialized as null.
    const noMemo: Invoice = { ...invoice };
    delete (noMemo as Partial<Invoice>).memo;
    expect(canonicalize(noMemo)).not.toContain("memo");
    expect(hashInvoice(noMemo)).not.toBe(hashInvoice(invoice));
  });

  it("changes when any field changes (nonce binds the challenge)", () => {
    const other: Invoice = { ...invoice, nonce: `0x${"00".repeat(32)}` as Invoice["nonce"] };
    expect(hashInvoice(other)).not.toBe(hashInvoice(invoice));
  });
});
