/**
 * Area 4 — createInvoice: injected determinism, random-nonce quality.
 */
import { describe, expect, it } from "vitest";
import { createInvoice } from "@dovizir/notes";
import { RECIPIENT, T0, makeInvoice, nonceAt } from "./support/fixtures";

describe("createInvoice", () => {
  it("respects an injected nonce and createdAt verbatim", () => {
    const inv = makeInvoice(RECIPIENT.publicKey, 5_000_000n, 42);
    expect(inv.nonce).toBe(nonceAt(42));
    expect(inv.createdAt).toBe(T0 - 100);
  });

  it("carries recipient public key, amount, and memo", () => {
    const inv = createInvoice({
      recipient: { publicKey: RECIPIENT.publicKey },
      amount: 25_000_000n,
      memo: "invoice memo",
      nonce: nonceAt(7),
      createdAt: T0,
    });
    expect(inv.recipient.toLowerCase()).toBe(RECIPIENT.publicKey);
    expect(inv.amount).toBe(25_000_000n);
    expect(inv.memo).toBe("invoice memo");
  });

  it("accepts a bare { publicKey } recipient (no private key required to invoice)", () => {
    const inv = createInvoice({
      recipient: { publicKey: RECIPIENT.publicKey },
      amount: 1n,
      nonce: nonceAt(8),
    });
    expect(inv.recipient.toLowerCase()).toBe(RECIPIENT.publicKey);
  });

  it("generates a 32-byte hex nonce when none is injected", () => {
    const inv = createInvoice({
      recipient: { publicKey: RECIPIENT.publicKey },
      amount: 1n,
    });
    expect(inv.nonce).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it("generates unique nonces across calls (challenge freshness)", () => {
    const nonces = new Set(
      Array.from({ length: 50 }, () =>
        createInvoice({ recipient: { publicKey: RECIPIENT.publicKey }, amount: 1n }).nonce,
      ),
    );
    expect(nonces.size).toBe(50);
  });
});
