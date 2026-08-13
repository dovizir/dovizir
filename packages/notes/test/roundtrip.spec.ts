/**
 * Arm A property tests: everything the library PRODUCES must verify through
 * its own verifiers, across randomized batch shapes — including odd batch
 * sizes the referee deliberately leaves unpinned.
 */
import { describe, expect, it } from "vitest";
import {
  ReconcileTracker,
  carveBatch,
  createInvoice,
  spendNote,
  verifyCertChain,
  verifyTranscript,
} from "../src/index.js";
import {
  CARVER,
  DENOMS,
  NOTE_EXPIRY,
  RECIPIENT,
  ROOT,
  SALT,
  T0,
  TRANCHE,
  batchOf,
  certPair,
  invoiceFor,
  nonceAt,
  prng,
} from "./support.js";

const { sarrafCert, memberCert } = certPair();

function verify(t: ReturnType<typeof spendNote>, now = T0) {
  return verifyTranscript({
    transcript: t,
    memberCert,
    sarrafCert,
    rootPublicKey: ROOT.publicKey,
    now,
    expectedRecipient: RECIPIENT.publicKey,
  });
}

describe("round trip: spend -> verify for every batch shape", () => {
  // 1..9 covers single-leaf, even, odd, power-of-two and promoted-node trees.
  for (let size = 1; size <= 9; size++) {
    it(`every note in a ${size}-note batch verifies`, () => {
      const denoms = Array.from({ length: size }, (_, i) => BigInt(i + 1) * 1_000_000n);
      const batch = carveBatch({
        carver: CARVER,
        trancheId: TRANCHE,
        denominations: denoms,
        expiry: NOTE_EXPIRY,
        batchSalt: SALT,
      });
      for (let i = 0; i < size; i++) {
        const invoice = invoiceFor(denoms[i]!, i + 1);
        const t = spendNote({ batch, noteIndex: i, invoice, carver: CARVER });
        const res = verify(t);
        expect(res, `note ${i} of ${size}`).toEqual({ valid: true });
      }
    });
  }

  it("randomized denominations and salts always round-trip (200 cases)", () => {
    const rand = prng(0xd0121);
    for (let caseNo = 0; caseNo < 200; caseNo++) {
      const size = 1 + Math.floor(rand() * 8);
      // Bounded by the fixture member cap (100e6) so CAP_EXCEEDED never fires.
      const denoms = Array.from({ length: size }, () => BigInt(Math.floor(rand() * 99_000_000)) + 1n);
      const salt = `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("")}` as const;
      const batch = carveBatch({
        carver: CARVER,
        trancheId: TRANCHE,
        denominations: denoms,
        expiry: NOTE_EXPIRY,
        batchSalt: salt,
      });
      const idx = Math.floor(rand() * size);
      const invoice = invoiceFor(denoms[idx]!, caseNo + 1);
      const t = spendNote({ batch, noteIndex: idx, invoice, carver: CARVER });
      expect(verify(t).valid, `case ${caseNo}`).toBe(true);
    }
  });
});

describe("round trip: certs and tracker agree with the verifier", () => {
  it("issueCert output always passes verifyCertChain before expiry", () => {
    expect(verifyCertChain({ memberCert, sarrafCert, rootPublicKey: ROOT.publicKey, now: T0 })).toEqual({
      valid: true,
    });
  });

  it("a tracker accepts everything verifyTranscript accepts", () => {
    const tracker = new ReconcileTracker();
    const batch = batchOf();
    for (let i = 0; i < DENOMS.length; i++) {
      const invoice = invoiceFor(DENOMS[i]!, 100 + i);
      const t = spendNote({ batch, noteIndex: i, invoice, carver: CARVER });
      expect(verify(t).valid).toBe(true);
      expect(tracker.submit(t).status).toBe("accepted");
      expect(tracker.isSpent(t.serial)).toBe(true);
    }
    expect(tracker.convictions()).toEqual([]);
  });

  it("createInvoice without injected values still verifies end-to-end", () => {
    const invoice = createInvoice({ recipient: { publicKey: RECIPIENT.publicKey }, amount: DENOMS[0]! });
    const batch = batchOf();
    const t = spendNote({ batch, noteIndex: 0, invoice, carver: CARVER });
    expect(verify(t).valid).toBe(true);
  });
});

describe("wire stability", () => {
  it("nonceAt fixtures are 32-byte and unique", () => {
    expect(nonceAt(1)).not.toBe(nonceAt(2));
    expect(nonceAt(255)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
