/**
 * Arm A adversarial tests: every field of a transcript is tamper-evident —
 * a mutation of ANY byte-bearing field must flip the verdict to invalid
 * (whatever the reason), and the tracker must refuse it rather than convict.
 */
import { describe, expect, it } from "vitest";
import { ReconcileTracker, verifyTranscript, type Hex, type Transcript } from "../src/index.js";
import { RECIPIENT, ROOT, T0, certPair, transcriptFor } from "./support.js";

const { sarrafCert, memberCert } = certPair();

function verify(t: Transcript) {
  return verifyTranscript({
    transcript: t,
    memberCert,
    sarrafCert,
    rootPublicKey: ROOT.publicKey,
    now: T0,
    expectedRecipient: RECIPIENT.publicKey,
  });
}

const flip = (h: Hex): Hex => {
  const nib = h[h.length - 1] === "0" ? "1" : "0";
  return (h.slice(0, -1) + nib) as Hex;
};

describe("tamper evidence: single-field mutations always invalidate", () => {
  const base = transcriptFor(2, 7);
  expect(verify(base).valid).toBe(true); // sanity: fixture is good

  const mutations: Array<[string, (t: Transcript) => void]> = [
    ["serial", (t) => (t.serial = flip(t.serial))],
    ["value", (t) => (t.value = t.value + 1n)],
    ["batchRoot", (t) => (t.batchRoot = flip(t.batchRoot))],
    ["proof element", (t) => (t.proof = [flip(t.proof[0]!), ...t.proof.slice(1)])],
    ["proof truncation", (t) => (t.proof = t.proof.slice(1))],
    ["proof extension", (t) => (t.proof = [...t.proof, t.proof[0]!])],
    ["invoiceHash", (t) => (t.invoiceHash = flip(t.invoiceHash))],
    ["invoice.amount", (t) => (t.invoice.amount = t.invoice.amount + 1n)],
    ["invoice.nonce", (t) => (t.invoice.nonce = flip(t.invoice.nonce))],
    ["invoice.recipient", (t) => (t.invoice.recipient = ROOT.publicKey)],
    ["invoice.memo added", (t) => (t.invoice.memo = "surprise")],
    ["carver", (t) => (t.carver = ROOT.publicKey)],
    ["signature", (t) => (t.signature = flip(t.signature))],
  ];

  it.each(mutations)("mutating %s invalidates the transcript", (_label, mutate) => {
    const t = structuredClone(base);
    mutate(t);
    const res = verify(t);
    expect(res.valid).toBe(false);
    expect(res.reason).toBeDefined();
  });

  it.each(mutations)("the tracker refuses a transcript with mutated %s (no conviction)", (_label, mutate) => {
    const tracker = new ReconcileTracker();
    tracker.submit(structuredClone(base));
    const t = structuredClone(base);
    mutate(t);
    let outcomeStatus: string | undefined;
    try {
      outcomeStatus = tracker.submit(t).status;
    } catch {
      outcomeStatus = "rejected";
    }
    // A tampered variant must NEVER read as a fresh accepted spend. It either
    // throws (invalid) or — when internally self-consistent, e.g. a re-signed
    // different invoice would be — surfaces as the duplicate it is. Field
    // mutations here break sig/proof/hash, so acceptance is impossible.
    expect(outcomeStatus === "rejected" || outcomeStatus === "duplicate").toBe(true);
    expect(tracker.isSpent(base.serial)).toBe(true);
  });

  it("expiry lowering flips the verdict to EXPIRED_NOTE (unsigned field, verifier-enforced)", () => {
    const t = structuredClone(base);
    t.expiry = T0; // now >= expiry
    const res = verify(t);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("EXPIRED_NOTE");
  });
});
