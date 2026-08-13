/**
 * Area 8 — ReconcileTracker: first-spend-wins state machine with conviction
 * evidence for double-spends.
 * Pinned rules:
 *   - Identity is canonical bytes: a structurally identical resubmission
 *     (deep clone) of an accepted transcript returns the ORIGINAL accepted
 *     outcome — idempotent, never a conviction.
 *   - Same serial under a DIFFERENT invoice -> duplicate + Conviction
 *     { serial, carver, transcripts: [original accepted, current submission],
 *       victims: recipients of every conflicting spend after the first, in
 *       submission order }.
 *   - The tracker verifies structure + signature + proof itself (not certs);
 *     an invalid transcript makes submit THROW an Error whose message contains
 *     the matching VerifyResult reason code — it is neither accepted nor
 *     convicted and leaves no state behind.
 */
import { describe, expect, it } from "vitest";
import { ReconcileTracker, spendNote, type Transcript } from "@dovizir/notes";
import { clone, flipLastByte } from "./support/helpers";
import {
  CARVER,
  DENOMS,
  RECIPIENT,
  RECIPIENT2,
  RECIPIENT3,
  makeBatch,
  makeInvoice,
} from "./support/fixtures";

const batch = makeBatch();

function spendTo(noteIndex: number, recipientPub: `0x${string}`, nonceIndex: number): Transcript {
  const invoice = makeInvoice(recipientPub, batch.notes[noteIndex].value, nonceIndex);
  return spendNote({ batch, noteIndex, invoice, carver: CARVER });
}

const t1 = spendTo(0, RECIPIENT.publicKey, 1);
const t2 = spendTo(0, RECIPIENT2.publicKey, 2);
const t3 = spendTo(0, RECIPIENT3.publicKey, 3);
const u1 = spendTo(1, RECIPIENT.publicKey, 4);
const u2 = spendTo(1, RECIPIENT2.publicKey, 5);

describe("ReconcileTracker: acceptance", () => {
  it("accepts a first-seen valid transcript and marks its serial spent", () => {
    const tracker = new ReconcileTracker();
    const out = tracker.submit(clone(t1));
    expect(out).toEqual({
      status: "accepted",
      serial: t1.serial,
      recipient: RECIPIENT.publicKey,
      value: DENOMS[0],
    });
    expect(tracker.isSpent(t1.serial)).toBe(true);
  });

  it("isSpent is false for a serial never submitted", () => {
    const tracker = new ReconcileTracker();
    tracker.submit(clone(t1));
    expect(tracker.isSpent(batch.notes[2].serial)).toBe(false);
  });
});

describe("ReconcileTracker: idempotent re-broadcast", () => {
  it("a byte-identical resubmit returns the ORIGINAL accepted outcome, with no conviction", () => {
    const tracker = new ReconcileTracker();
    const first = tracker.submit(clone(t1));
    const again = tracker.submit(clone(t1)); // deep clone: identity by bytes, not object reference
    expect(again).toEqual(first);
    expect(again.status).toBe("accepted");
    expect(tracker.convictions()).toEqual([]);
  });
});

describe("ReconcileTracker: double-spend conviction", () => {
  it("same serial under a different invoice returns duplicate with full conviction evidence", () => {
    const tracker = new ReconcileTracker();
    tracker.submit(clone(t1));
    const out = tracker.submit(clone(t2));
    expect(out.status).toBe("duplicate");
    if (out.status !== "duplicate") return;
    expect(out.conviction.serial).toBe(t1.serial);
    expect(out.conviction.carver.toLowerCase()).toBe(CARVER.publicKey);
    expect(out.conviction.transcripts[0].invoiceHash).toBe(t1.invoiceHash);
    expect(out.conviction.transcripts[1].invoiceHash).toBe(t2.invoiceHash);
    expect(out.conviction.victims).toEqual([RECIPIENT2.publicKey]);
  });

  it("a third conflicting spend accumulates victims in submission order", () => {
    const tracker = new ReconcileTracker();
    tracker.submit(clone(t1));
    tracker.submit(clone(t2));
    const out = tracker.submit(clone(t3));
    expect(out.status).toBe("duplicate");
    if (out.status !== "duplicate") return;
    expect(out.conviction.victims).toEqual([
      RECIPIENT2.publicKey,
      RECIPIENT3.publicKey,
    ]);
    // PINNED: the transcript pair is [original accepted, current submission].
    expect(out.conviction.transcripts[0].invoiceHash).toBe(t1.invoiceHash);
    expect(out.conviction.transcripts[1].invoiceHash).toBe(t3.invoiceHash);
  });

  it("convictions() lists each convicted serial exactly once", () => {
    const tracker = new ReconcileTracker();
    tracker.submit(clone(t1));
    tracker.submit(clone(t2));
    tracker.submit(clone(t3)); // serial 0 convicted twice over
    tracker.submit(clone(u1));
    tracker.submit(clone(u2)); // serial 1 convicted once
    const cs = tracker.convictions();
    expect(cs.length).toBe(2);
    const serials = cs.map((c) => c.serial).sort();
    expect(serials).toEqual([t1.serial, u1.serial].sort());
    const bySerial = new Map(cs.map((c) => [c.serial, c]));
    expect(bySerial.get(t1.serial)?.victims).toEqual([
      RECIPIENT2.publicKey,
      RECIPIENT3.publicKey,
    ]);
    expect(bySerial.get(u1.serial)?.victims).toEqual([RECIPIENT2.publicKey]);
  });

  it("a clean spend after a conviction elsewhere is still accepted", () => {
    const tracker = new ReconcileTracker();
    tracker.submit(clone(t1));
    tracker.submit(clone(t2));
    const out = tracker.submit(clone(u1));
    expect(out.status).toBe("accepted");
  });
});

describe("ReconcileTracker: the tracker verifies transcripts itself", () => {
  it("a tampered signature throws (message names BAD_SIGNATURE) and leaves no state", () => {
    const tracker = new ReconcileTracker();
    const forged = clone(t1);
    forged.signature = flipLastByte(forged.signature);
    expect(() => tracker.submit(forged)).toThrowError(/BAD_SIGNATURE/);
    expect(tracker.isSpent(t1.serial)).toBe(false);
    expect(tracker.convictions()).toEqual([]);
  });

  it("a tampered proof throws (message names BAD_PROOF) and is not convicted", () => {
    const tracker = new ReconcileTracker();
    tracker.submit(clone(t1));
    const forged = clone(t2);
    forged.proof = [...forged.proof];
    forged.proof[0] = flipLastByte(forged.proof[0]);
    expect(() => tracker.submit(forged)).toThrowError(/BAD_PROOF/);
    expect(tracker.convictions()).toEqual([]); // rejected, not treated as a double-spend
  });

  it("a structurally broken submission throws (message names MALFORMED)", () => {
    const tracker = new ReconcileTracker();
    expect(() => tracker.submit({} as Transcript)).toThrowError(/MALFORMED/);
  });

  it("a genuine transcript still passes after a rejected forgery", () => {
    const tracker = new ReconcileTracker();
    const forged = clone(t1);
    forged.signature = flipLastByte(forged.signature);
    try {
      tracker.submit(forged);
    } catch {
      // expected
    }
    const out = tracker.submit(clone(t1));
    expect(out.status).toBe("accepted");
    expect(tracker.isSpent(t1.serial)).toBe(true);
  });
});
