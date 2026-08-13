/**
 * Area 9 — one-hop property: a transcript is bound to its invoice and can only
 * be minted by the carver. A recipient who received a note CANNOT re-spend it
 * by constructing a new transcript — every forgery either breaks the carver
 * signature or breaks the cert chain.
 */
import { describe, expect, it } from "vitest";
import { clone } from "./support/helpers";
import {
  RECIPIENT,
  RECIPIENT2,
  check,
  makeInvoice,
  makeWorld,
  rebindInvoice,
  resign,
} from "./support/fixtures";

const world = makeWorld();
// RECIPIENT holds world.transcript and now tries to pass the note on to
// RECIPIENT2 without the carver's private key.
const fenceInvoice = makeInvoice(RECIPIENT2.publicKey, world.transcript.value, 21);

describe("one-hop: forged second hops must fail verification", () => {
  it("reusing the carver's signature under a new invoice fails with BAD_SIGNATURE", () => {
    // Honest-looking forgery: swap invoice, recompute invoiceHash, keep sig.
    const forged = rebindInvoice(world.transcript, fenceInvoice, null);
    const res = check(world, forged, { expectedRecipient: RECIPIENT2.publicKey });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_SIGNATURE");
  });

  it("swapping the invoice while keeping the old invoiceHash also fails", () => {
    const forged = clone(world.transcript);
    forged.invoice = fenceInvoice; // invoiceHash still hashes the ORIGINAL invoice
    const res = check(world, forged, { expectedRecipient: RECIPIENT2.publicKey });
    expect(res.valid).toBe(false); // reason unpinned: hash/invoice inconsistency
  });

  it("re-signing with the recipient's own key (carver field unchanged) fails with BAD_SIGNATURE", () => {
    const forged = rebindInvoice(world.transcript, fenceInvoice, RECIPIENT.privateKey);
    const res = check(world, forged, { expectedRecipient: RECIPIENT2.publicKey });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_SIGNATURE");
  });

  it("re-signing AND claiming to be the carver fails the cert chain (member cert names the real carver)", () => {
    const forged = rebindInvoice(world.transcript, fenceInvoice, RECIPIENT.privateKey);
    forged.carver = RECIPIENT.publicKey;
    forged.signature = resign(forged, RECIPIENT.privateKey);
    const res = check(world, forged, { expectedRecipient: RECIPIENT2.publicKey });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_CERT_CHAIN");
  });

  it("the original first-hop transcript remains valid for its own recipient", () => {
    const res = check(world, world.transcript);
    expect(res.valid).toBe(true);
  });
});
