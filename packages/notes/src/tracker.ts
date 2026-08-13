/**
 * ReconcileTracker — in-memory first-spend-wins state machine (indexer /
 * vault mirror). Frozen rules (referee pin #10):
 *  - the tracker verifies structure + carver signature + merkle proof itself
 *    (NOT certs — the chain's job); an invalid submission THROWS an Error
 *    whose message contains the matching VerifyResult reason code, leaving no
 *    state behind;
 *  - transcript identity is canonical bytes: a byte-identical resubmission of
 *    an accepted transcript returns the ORIGINAL accepted outcome (idempotent
 *    re-broadcast, never a conviction);
 *  - the same serial under a different invoice convicts:
 *    conviction.transcripts = [original accepted, current submission] and
 *    victims accumulate the conflicting recipients in submission order;
 *  - convictions() lists each convicted serial exactly once.
 */
import { canonicalize } from "./canonicalize.js";
import { verifyDigest } from "./crypto.js";
import { hashInvoice, spendDigest } from "./notes.js";
import { buildLeafAndVerify } from "./verify-proof.js";
import { transcriptShapeValid } from "./verify.js";
import type { Conviction, Hex, ReconcileOutcome, Transcript } from "./types.js";

interface AcceptedRecord {
  canonical: string;
  transcript: Transcript; // defensive clone of the first accepted submission
  outcome: Extract<ReconcileOutcome, { status: "accepted" }>;
}

export class ReconcileTracker {
  readonly #accepted = new Map<string, AcceptedRecord>(); // key: lowercase serial
  readonly #convictions = new Map<string, Conviction>();
  readonly #seenConflicts = new Map<string, Set<string>>(); // canonical bytes per serial

  submit(transcript: Transcript): ReconcileOutcome {
    this.#validate(transcript);
    const key = transcript.serial.toLowerCase();
    const canonical = canonicalize(transcript);

    const prior = this.#accepted.get(key);
    if (!prior) {
      const record: AcceptedRecord = {
        canonical,
        transcript: structuredClone(transcript),
        outcome: {
          status: "accepted",
          serial: transcript.serial,
          recipient: transcript.invoice.recipient,
          value: transcript.value,
        },
      };
      this.#accepted.set(key, record);
      return record.outcome;
    }

    if (prior.canonical === canonical) {
      // Byte-identical re-broadcast: idempotent, the original outcome.
      return prior.outcome;
    }

    // Conflicting spend of an already-accepted serial: conviction.
    let conviction = this.#convictions.get(key);
    let seen = this.#seenConflicts.get(key);
    if (!conviction || !seen) {
      conviction = {
        serial: prior.transcript.serial,
        carver: prior.transcript.carver,
        transcripts: [prior.transcript, structuredClone(transcript)],
        victims: [],
      };
      seen = new Set<string>();
      this.#convictions.set(key, conviction);
      this.#seenConflicts.set(key, seen);
    } else {
      conviction.transcripts = [prior.transcript, structuredClone(transcript)];
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      conviction.victims.push(transcript.invoice.recipient);
    }
    return { status: "duplicate", conviction };
  }

  isSpent(serial: Hex): boolean {
    return this.#accepted.has(serial.toLowerCase());
  }

  convictions(): Conviction[] {
    return [...this.#convictions.values()];
  }

  #validate(t: Transcript): void {
    if (!transcriptShapeValid(t)) {
      throw new Error("ReconcileTracker: invalid transcript (MALFORMED)");
    }
    if (hashInvoice(t.invoice).toLowerCase() !== t.invoiceHash.toLowerCase()) {
      throw new Error("ReconcileTracker: invoiceHash does not commit the invoice (MALFORMED)");
    }
    if (!verifyDigest(t.signature, spendDigest(t.serial, t.invoiceHash), t.carver)) {
      throw new Error("ReconcileTracker: carver signature invalid (BAD_SIGNATURE)");
    }
    if (!buildLeafAndVerify(t.serial, t.value, t.proof, t.batchRoot)) {
      throw new Error("ReconcileTracker: merkle proof invalid (BAD_PROOF)");
    }
    if (t.value !== t.invoice.amount) {
      throw new Error("ReconcileTracker: value differs from invoiced amount (VALUE_MISMATCH)");
    }
  }
}
