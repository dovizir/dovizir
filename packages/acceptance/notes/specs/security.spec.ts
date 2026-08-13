/**
 * Regression suite encoding the PoC-verified findings from the M1 adversarial
 * review (docs/experiment/REVIEW-FINDINGS-M1.md). Each block FAILS against the
 * pre-amendment library and PASSES after the §5–§8 fixes.
 */
import { describe, expect, it } from "vitest";
import {
  ReconcileTracker,
  hashInvoice,
  issueCert,
  spendNote,
  verifyCertChain,
  type Transcript,
} from "@dovizir/notes";
import { clone } from "./support/helpers";
import {
  CARVER,
  CERT_EXPIRY,
  RECIPIENT,
  RECIPIENT2,
  ROOT,
  SARRAF,
  T0,
  makeBatch,
  makeInvoice,
} from "./support/fixtures";

const batch = makeBatch();
function accepted(): Transcript {
  const invoice = makeInvoice(RECIPIENT.publicKey, batch.notes[0].value, 1);
  return spendNote({ batch, noteIndex: 0, invoice, carver: CARVER });
}

/**
 * §5/§6 — CRITICAL: false double-spend conviction of an honest carver.
 * The reviewers replayed an accepted transcript with an UNSIGNED field mutated
 * (expiry+1, or a swapped batchRoot). The old tracker keyed identity off full
 * canonical bytes, so "different bytes, same serial" convicted the honest
 * carver with two transcripts carrying the SAME signature. After §5 those
 * fields are signed and after §6 identity is the signed material, so the replay
 * can never produce a conviction.
 */
describe("§5/§6 false-conviction is not exploitable", () => {
  it("replaying an accepted transcript with a mutated expiry never convicts the carver", () => {
    const tracker = new ReconcileTracker();
    const t1 = accepted();
    tracker.submit(clone(t1));

    const mutated = clone(t1);
    mutated.expiry = t1.expiry + 1; // unsigned in the old spec — now signed (§5)

    // The mutated expiry no longer matches the carver signature: rejected, and
    // crucially NOT treated as a conflicting spend.
    expect(() => tracker.submit(mutated)).toThrowError(/BAD_SIGNATURE/);
    expect(tracker.convictions()).toEqual([]);
    expect(tracker.isSpent(t1.serial)).toBe(true);
  });

  it("replaying with a swapped batchRoot never convicts the carver", () => {
    const tracker = new ReconcileTracker();
    const t1 = accepted();
    tracker.submit(clone(t1));

    const mutated = clone(t1);
    mutated.batchRoot = `0x${"ab".repeat(32)}`; // unsigned in the old spec — now signed (§5)

    expect(() => tracker.submit(mutated)).toThrowError(/BAD_(SIGNATURE|PROOF)/);
    expect(tracker.convictions()).toEqual([]);
  });

  it("a genuine same-serial DIFFERENT-invoice double-spend still convicts (no false negative)", () => {
    const tracker = new ReconcileTracker();
    const t1 = accepted();
    tracker.submit(clone(t1));

    const conflicting = spendNote({
      batch,
      noteIndex: 0,
      invoice: makeInvoice(RECIPIENT2.publicKey, batch.notes[0].value, 2),
      carver: CARVER,
    });
    const out = tracker.submit(clone(conflicting));
    expect(out.status).toBe("duplicate");
    expect(tracker.convictions().length).toBe(1);
  });
});

/**
 * §7 — MEDIUM: capLimit not chained. A sarraf could mint a member cert whose
 * cap exceeds its own root-granted cap. verifyCertChain now rejects it.
 */
describe("§7 capLimit chaining", () => {
  const sarrafCert = issueCert({
    issuer: ROOT,
    subject: SARRAF.publicKey,
    role: "sarraf",
    capLimit: 1_000_000_000n,
    expiry: CERT_EXPIRY,
  });

  it("rejects a member cap above the sarraf cap (BAD_CERT_CHAIN)", () => {
    const overCap = issueCert({
      issuer: SARRAF,
      subject: CARVER.publicKey,
      role: "member",
      sarraf: SARRAF.publicKey,
      capLimit: sarrafCert.capLimit + 1n, // exceeds the sarraf's own cap
      expiry: CERT_EXPIRY,
    });
    const res = verifyCertChain({ memberCert: overCap, sarrafCert, rootPublicKey: ROOT.publicKey, now: T0 });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_CERT_CHAIN");
  });

  it("accepts a member cap equal to the sarraf cap (boundary)", () => {
    const atCap = issueCert({
      issuer: SARRAF,
      subject: CARVER.publicKey,
      role: "member",
      sarraf: SARRAF.publicKey,
      capLimit: sarrafCert.capLimit,
      expiry: CERT_EXPIRY,
    });
    const res = verifyCertChain({ memberCert: atCap, sarrafCert, rootPublicKey: ROOT.publicKey, now: T0 });
    expect(res.valid).toBe(true);
  });
});

/**
 * §8 — LOW: canonicalize case-folded hex-looking free text, so distinct-case
 * memos collided to the same invoice commitment. They must now be distinct.
 */
describe("§8 memo integrity", () => {
  it("distinct-case hex-looking memos produce distinct invoice hashes", () => {
    const upper = makeInvoice(RECIPIENT.publicKey, 1_000n, 1, { memo: "0xABCDEF" });
    const lower = makeInvoice(RECIPIENT.publicKey, 1_000n, 1, { memo: "0xabcdef" });
    expect(hashInvoice(upper)).not.toBe(hashInvoice(lower));
  });
});
