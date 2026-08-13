/**
 * Area 6 — every VerifyResult reason is reachable from verifyTranscript, each
 * via exactly one deviation from a known-good world.
 * Interpretations pinned here (see README):
 *   VALUE_MISMATCH := transcript.value != transcript.invoice.amount
 *     (the d.ts gloss "note value proven" cannot fail independently of the
 *      proof, since the proof leaf binds the value — candidate spec bug).
 *   CAP boundary: value == capLimit is allowed; CAP_EXCEEDED iff value > cap.
 *   MALFORMED inputs return a result; verifyTranscript never throws.
 */
import { describe, expect, it } from "vitest";
import { issueCert, spendNote, verifyTranscript, type Transcript } from "@dovizir/notes";
import { clone, flipLastByte } from "./support/helpers";
import {
  CARVER,
  CERT_EXPIRY,
  DENOMS,
  MEMBER_CAP,
  NOTE_EXPIRY,
  RECIPIENT,
  RECIPIENT2,
  ROGUE,
  ROOT,
  SARRAF,
  T0,
  check,
  makeInvoice,
  makeWorld,
  rebindInvoice,
} from "./support/fixtures";

const world = makeWorld();

describe("verifyTranscript reason: BAD_SIGNATURE", () => {
  it("rejects a transcript whose carver signature bytes were tampered", () => {
    const t = clone(world.transcript);
    t.signature = flipLastByte(t.signature);
    const res = check(world, t);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_SIGNATURE");
  });
});

describe("verifyTranscript reason: BAD_PROOF", () => {
  it("rejects a transcript with a tampered merkle proof element", () => {
    const t = clone(world.transcript);
    t.proof = [...t.proof];
    t.proof[0] = flipLastByte(t.proof[0]);
    const res = check(world, t);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_PROOF");
  });

  it("rejects a transcript whose serial does not match the proven leaf", () => {
    // Re-sign with the (referee-held) carver key so ONLY the proof fails.
    const t = clone(world.transcript);
    t.serial = flipLastByte(t.serial);
    t.signature = rebindInvoice(t, t.invoice, CARVER.privateKey).signature;
    const res = check(world, t);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_PROOF");
  });
});

describe("verifyTranscript reason: EXPIRED_NOTE", () => {
  it("rejects a note past its expiry (now > expiry)", () => {
    const res = check(world, world.transcript, { now: NOTE_EXPIRY + 100 });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("EXPIRED_NOTE");
  });
});

describe("verifyTranscript reason: EXPIRED_CERT", () => {
  it("rejects when the carver's member cert is stale", () => {
    const staleMember = issueCert({
      issuer: SARRAF,
      subject: CARVER.publicKey,
      role: "member",
      sarraf: SARRAF.publicKey,
      capLimit: MEMBER_CAP,
      expiry: T0 - 10,
    });
    const res = check(world, world.transcript, { memberCert: staleMember });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("EXPIRED_CERT");
  });

  it("rejects when the sponsoring sarraf cert is stale", () => {
    const staleSarraf = issueCert({
      issuer: ROOT,
      subject: SARRAF.publicKey,
      role: "sarraf",
      capLimit: 10_000_000_000n,
      expiry: T0 - 10,
    });
    const res = check(world, world.transcript, { sarrafCert: staleSarraf });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("EXPIRED_CERT");
  });
});

describe("verifyTranscript reason: BAD_CERT_CHAIN", () => {
  it("rejects a member cert issued by a key that is not the presented sarraf", () => {
    const rogueMember = issueCert({
      issuer: ROGUE,
      subject: CARVER.publicKey,
      role: "member",
      sarraf: ROGUE.publicKey,
      capLimit: MEMBER_CAP,
      expiry: CERT_EXPIRY,
    });
    const res = check(world, world.transcript, { memberCert: rogueMember });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_CERT_CHAIN");
  });

  it("rejects a sarraf cert not signed by the root", () => {
    const rogueSarraf = issueCert({
      issuer: ROGUE,
      subject: SARRAF.publicKey,
      role: "sarraf",
      capLimit: 10_000_000_000n,
      expiry: CERT_EXPIRY,
    });
    const res = check(world, world.transcript, { sarrafCert: rogueSarraf });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_CERT_CHAIN");
  });

  it("rejects role confusion: a member-role cert presented as the sarraf cert", () => {
    // Root really signed it — but it grants membership, not sarraf status.
    const memberRoleAsSarraf = issueCert({
      issuer: ROOT,
      subject: SARRAF.publicKey,
      role: "member",
      sarraf: ROOT.publicKey,
      capLimit: 10_000_000_000n,
      expiry: CERT_EXPIRY,
    });
    const res = check(world, world.transcript, { sarrafCert: memberRoleAsSarraf });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_CERT_CHAIN");
  });
});

describe("verifyTranscript reason: RECIPIENT_MISMATCH", () => {
  it("rejects when expectedRecipient differs from invoice.recipient", () => {
    const res = check(world, world.transcript, {
      expectedRecipient: RECIPIENT2.publicKey,
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("RECIPIENT_MISMATCH");
  });
});

describe("verifyTranscript reason: VALUE_MISMATCH", () => {
  it("rejects when transcript.value differs from invoice.amount (sig and proof intact)", () => {
    // Carver-signed over the mismatched invoice, proof still proves 5 IOU:
    // the ONLY failing check is value vs invoiced amount.
    const wrongAmountInvoice = makeInvoice(RECIPIENT.publicKey, 7_000_000n, 9);
    const t = rebindInvoice(world.transcript, wrongAmountInvoice, CARVER.privateKey);
    const res = check(world, t);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("VALUE_MISMATCH");
  });
});

describe("verifyTranscript reason: CAP_EXCEEDED", () => {
  it("rejects a spend above the member cert's capLimit", () => {
    // note 3 is 2000 IOU; member cap is 1000 IOU.
    const invoice = makeInvoice(RECIPIENT.publicKey, DENOMS[3], 10);
    const t = spendNote({ batch: world.batch, noteIndex: 3, invoice, carver: CARVER });
    const res = check(world, t);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("CAP_EXCEEDED");
  });

  it("allows a spend exactly at capLimit (exceeded means strictly greater)", () => {
    const capAtNote = issueCert({
      issuer: SARRAF,
      subject: CARVER.publicKey,
      role: "member",
      sarraf: SARRAF.publicKey,
      capLimit: DENOMS[3],
      expiry: CERT_EXPIRY,
    });
    const invoice = makeInvoice(RECIPIENT.publicKey, DENOMS[3], 11);
    const t = spendNote({ batch: world.batch, noteIndex: 3, invoice, carver: CARVER });
    const res = check(world, t, { memberCert: capAtNote });
    expect(res.valid).toBe(true);
  });
});

describe("verifyTranscript reason: MALFORMED", () => {
  const malformedInputs: Array<[string, unknown]> = [
    ["empty object", {}],
    ["null", null],
    ["non-hex serial", { ...makeWorld().transcript, serial: "not-hex" }],
    ["proof is not an array", { ...makeWorld().transcript, proof: "0xabc" }],
    ["missing invoice", (() => { const t = clone(makeWorld().transcript) as Partial<Transcript>; delete t.invoice; return t; })()],
  ];

  it.each(malformedInputs)(
    "returns { valid: false, reason: MALFORMED } without throwing for %s input",
    (_label, broken) => {
      let res: ReturnType<typeof verifyTranscript>;
      expect(() => {
        res = verifyTranscript({
          transcript: broken as Transcript,
          memberCert: world.memberCert,
          sarrafCert: world.sarrafCert,
          rootPublicKey: ROOT.publicKey,
          now: T0,
          expectedRecipient: RECIPIENT.publicKey,
        });
      }).not.toThrow();
      expect(res!.valid).toBe(false);
      expect(res!.reason).toBe("MALFORMED");
    },
  );
});
