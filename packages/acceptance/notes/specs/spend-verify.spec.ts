/**
 * Area 5 — spendNote transcript construction + verifyTranscript happy path.
 * Pinned rules:
 *   transcript.signature = carver secp256k1 sig over
 *     keccak256(serial ‖ invoiceHash ‖ u64be(expiry) ‖ batchRoot) (§5 amendment),
 *   64-byte compact r||s, RFC6979 deterministic, low-s.
 *   Expiry semantics: a note is valid iff now < expiry.
 */
import { describe, expect, it } from "vitest";
import { hashInvoice, spendNote } from "@dovizir/notes";
import {
  concatBytes,
  fromHex,
  keccak_256,
  sigValid,
  u64be,
} from "./support/helpers";
import {
  CARVER,
  DENOMS,
  NOTE_EXPIRY,
  RECIPIENT,
  makeWorld,
  check,
} from "./support/fixtures";

describe("spendNote: transcript construction", () => {
  const world = makeWorld();
  const t = world.transcript;
  const note = world.batch.notes[0];

  it("copies serial, value, proof, batchRoot, and expiry from the spent note/batch", () => {
    expect(t.serial.toLowerCase()).toBe(note.serial.toLowerCase());
    expect(t.value).toBe(note.value);
    expect(t.proof).toEqual(note.proof);
    expect(t.batchRoot.toLowerCase()).toBe(world.batch.batchRoot.toLowerCase());
    expect(t.expiry).toBe(NOTE_EXPIRY);
  });

  it("embeds the full invoice and its hash (invoiceHash == hashInvoice(invoice))", () => {
    expect(t.invoice).toEqual(world.invoice);
    expect(t.invoiceHash.toLowerCase()).toBe(hashInvoice(world.invoice).toLowerCase());
  });

  it("names the carver's public key", () => {
    expect(t.carver.toLowerCase()).toBe(CARVER.publicKey);
  });

  it("signature is a 64-byte compact secp256k1 sig over keccak256(serial ‖ invoiceHash ‖ expiry ‖ batchRoot) by the carver", () => {
    expect(t.signature).toMatch(/^0x[0-9a-f]{128}$/i);
    // §5 amendment: expiry + batchRoot are signed into the digest.
    const digest = keccak_256(
      concatBytes(fromHex(t.serial), fromHex(t.invoiceHash), u64be(t.expiry), fromHex(t.batchRoot)),
    );
    expect(sigValid(t.signature, digest, CARVER.publicKey)).toBe(true);
  });
});

describe("verifyTranscript: happy path", () => {
  const world = makeWorld();

  it("accepts a correct chain (root -> sarrafCert -> memberCert), fresh certs and note, matching recipient", () => {
    const res = check(world, world.transcript);
    expect(res.valid).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it("accepts for any note in the batch (independent proofs)", () => {
    // note 2 (25 IOU) is under the member cap
    const invoice = { ...world.invoice, amount: DENOMS[2] };
    const t = spendNote({ batch: world.batch, noteIndex: 2, invoice, carver: CARVER });
    const res = check(world, t);
    expect(res.valid).toBe(true);
  });

  it("is valid at now == expiry - 1 (note freshness boundary)", () => {
    const res = check(world, world.transcript, { now: NOTE_EXPIRY - 1 });
    expect(res.valid).toBe(true);
  });

  it("is invalid at now == expiry: a note is valid iff now < expiry", () => {
    // PINNED boundary: now == expiry is already expired.
    const res = check(world, world.transcript, { now: NOTE_EXPIRY });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("EXPIRED_NOTE");
  });

  it("binds to the verifier: valid only when expectedRecipient equals invoice.recipient", () => {
    const res = check(world, world.transcript, {
      expectedRecipient: RECIPIENT.publicKey,
    });
    expect(res.valid).toBe(true);
  });
});
