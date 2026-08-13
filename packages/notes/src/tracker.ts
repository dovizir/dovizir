/**
 * ReconcileTracker — in-memory first-spend-wins state machine (indexer /
 * vault mirror). Frozen rules (referee pin #10):
 *  - the tracker verifies structure + carver signature + merkle proof itself
 *    (NOT certs — the chain's job); an invalid submission THROWS an Error
 *    whose message contains the matching VerifyResult reason code, leaving no
 *    state behind;
 *  - transcript identity is the SIGNED material (review §6):
 *    serial ‖ invoiceHash ‖ signature. A resubmission carrying the same signed
 *    identity returns the ORIGINAL accepted outcome (idempotent re-broadcast,
 *    never a conviction) — even if an UNSIGNED field (e.g. proof) was mutated.
 *    Conviction requires a DIFFERENT signed invoice for the same serial. Since
 *    expiry + batchRoot are now signed too (§5), mutating them invalidates the
 *    signature and the submission is rejected (BAD_SIGNATURE), never convicted;
 *  - the same serial under a different invoice convicts:
 *    conviction.transcripts = [original accepted, current submission] and
 *    victims accumulate the conflicting recipients in submission order;
 *  - convictions() lists each convicted serial exactly once.
 */
import { verifyDigest } from "./crypto.js";
import { hashInvoice, spendDigest } from "./notes.js";
import { buildLeafAndVerify } from "./verify-proof.js";
import { transcriptShapeValid } from "./verify.js";
import type { Conviction, Hex, ReconcileOutcome, Transcript } from "./types.js";

interface AcceptedRecord {
  identity: string;
  transcript: Transcript; // defensive clone of the first accepted submission
  outcome: Extract<ReconcileOutcome, { status: "accepted" }>;
}

/** Idempotency/dup identity is the SIGNED material only (review §6):
 * serial ‖ invoiceHash ‖ signature. Unsigned fields (e.g. proof) never affect
 * identity, so mutating one cannot frame the carver with a false conviction. */
function signedIdentity(t: Transcript): string {
  return `${t.serial.toLowerCase()}|${t.invoiceHash.toLowerCase()}|${t.signature.toLowerCase()}`;
}

export class ReconcileTracker {
  readonly #accepted = new Map<string, AcceptedRecord>(); // key: lowercase serial
  readonly #convictions = new Map<string, Conviction>();
  readonly #seenConflicts = new Map<string, Set<string>>(); // signed identity per serial

  submit(transcript: Transcript): ReconcileOutcome {
    this.#validate(transcript);
    const key = transcript.serial.toLowerCase();
    const identity = signedIdentity(transcript);

    const prior = this.#accepted.get(key);
    if (!prior) {
      const record: AcceptedRecord = {
        identity,
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

    if (prior.identity === identity) {
      // Same signed material re-broadcast: idempotent, the original outcome.
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
    if (!seen.has(identity)) {
      seen.add(identity);
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
    if (!verifyDigest(t.signature, spendDigest(t.serial, t.invoiceHash, t.expiry, t.batchRoot), t.carver)) {
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
