/**
 * Arm A unit tests for corners the referee leaves unexercised: canonicalize
 * edge inputs, keypair hygiene, tracker conviction bookkeeping, verifier
 * reason precedence, and cert-chain misuse.
 */
import { describe, expect, it } from "vitest";
import {
  ReconcileTracker,
  canonicalize,
  carveBatch,
  generateKeyPair,
  issueCert,
  spendNote,
  verifyCertChain,
  verifyTranscript,
  type Hex,
  type Transcript,
} from "../src/index.js";
import {
  CARVER,
  CERT_EXPIRY,
  DENOMS,
  NOTE_EXPIRY,
  OTHER,
  RECIPIENT,
  ROOT,
  SARRAF,
  T0,
  TRANCHE,
  batchOf,
  certPair,
  invoiceFor,
  transcriptFor,
} from "./support.js";

const { sarrafCert, memberCert } = certPair();

describe("canonicalize edges", () => {
  it("handles nested arrays of objects with sorted keys", () => {
    expect(canonicalize({ a: [{ z: 1, y: 2 }, 3n] })).toBe('{"a":[{"y":2,"z":1},"0x3"]}');
  });

  it("serializes strings verbatim, without case-folding hex-looking values (§8)", () => {
    // AMENDED (review §8): the serializer no longer lowercases hex-looking
    // strings; byte fields are lowercased at their typed construction sites, so
    // hex-looking free text (e.g. a memo) is preserved verbatim.
    expect(canonicalize({ s: "0xZZ" })).toBe('{"s":"0xZZ"}'); // not hex: untouched
    expect(canonicalize({ s: "0xAB" })).toBe('{"s":"0xAB"}'); // preserved verbatim
  });

  it("escapes JSON control characters but not UTF-8", () => {
    expect(canonicalize({ m: 'a"b\n☕' })).toBe('{"m":"a\\"b\\n☕"}');
  });

  it("throws on negative bigints and non-finite numbers", () => {
    expect(() => canonicalize({ v: -1n })).toThrow();
    expect(() => canonicalize({ v: Number.NaN })).toThrow();
    expect(() => canonicalize({ v: Infinity })).toThrow();
  });

  it("treats explicitly-undefined keys exactly like absent keys", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
});

describe("generateKeyPair hygiene", () => {
  it("accepts seeds of any byte length deterministically", () => {
    const short = generateKeyPair("0x01" as Hex);
    expect(short.privateKey).toBe(generateKeyPair("0x01" as Hex).privateKey);
    expect(short.publicKey).toMatch(/^0x0[23][0-9a-f]{64}$/);
  });

  it("rejects non-hex seeds", () => {
    expect(() => generateKeyPair("nope" as Hex)).toThrow();
    expect(() => generateKeyPair("0x123" as Hex)).toThrow(); // odd nibbles
  });
});

describe("carveBatch guards", () => {
  it("rejects empty denomination lists and negative values", () => {
    expect(() =>
      carveBatch({ carver: CARVER, trancheId: TRANCHE, denominations: [], expiry: NOTE_EXPIRY }),
    ).toThrow();
    expect(() =>
      carveBatch({ carver: CARVER, trancheId: TRANCHE, denominations: [-1n], expiry: NOTE_EXPIRY }),
    ).toThrow();
  });

  it("generates a fresh 32-byte salt when none is injected, and distinct roots", () => {
    const a = carveBatch({ carver: CARVER, trancheId: TRANCHE, denominations: [1n], expiry: NOTE_EXPIRY });
    const b = carveBatch({ carver: CARVER, trancheId: TRANCHE, denominations: [1n], expiry: NOTE_EXPIRY });
    expect(a.batchSalt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.batchSalt).not.toBe(b.batchSalt);
    expect(a.batchRoot).not.toBe(b.batchRoot);
  });
});

describe("spendNote guards", () => {
  it("rejects an out-of-range note index", () => {
    const batch = batchOf();
    expect(() =>
      spendNote({ batch, noteIndex: batch.notes.length, invoice: invoiceFor(1n), carver: CARVER }),
    ).toThrow();
  });

  it("rejects a carver key that does not match the batch", () => {
    const batch = batchOf();
    expect(() => spendNote({ batch, noteIndex: 0, invoice: invoiceFor(1n), carver: OTHER })).toThrow();
  });
});

describe("verifier precedence and cert misuse", () => {
  it("cert-chain failure wins over note expiry (chain is checked first)", () => {
    const { memberCert: staleMember } = certPair({ memberExpiry: T0 - 1 });
    const t = transcriptFor(0, 3);
    const res = verifyTranscript({
      transcript: t,
      memberCert: staleMember,
      sarrafCert,
      rootPublicKey: ROOT.publicKey,
      now: NOTE_EXPIRY + 5, // note ALSO expired
      expectedRecipient: RECIPIENT.publicKey,
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("EXPIRED_CERT");
  });

  it("a self-issued sarraf cert cannot root a chain under a different root key", () => {
    const selfSarraf = issueCert({
      issuer: SARRAF, // signs itself
      subject: SARRAF.publicKey,
      role: "sarraf",
      capLimit: 1n,
      expiry: CERT_EXPIRY,
    });
    const res = verifyCertChain({
      memberCert,
      sarrafCert: selfSarraf,
      rootPublicKey: ROOT.publicKey,
      now: T0,
    });
    expect(res).toEqual({ valid: false, reason: "BAD_CERT_CHAIN" });
  });

  it("member cert whose sarraf field disagrees with the presented sarraf cert fails", () => {
    const crossMember = issueCert({
      issuer: SARRAF,
      subject: CARVER.publicKey,
      role: "member",
      sarraf: OTHER.publicKey, // linkage lie, but correctly signed
      capLimit: 100_000_000n,
      expiry: CERT_EXPIRY,
    });
    const res = verifyCertChain({
      memberCert: crossMember,
      sarrafCert,
      rootPublicKey: ROOT.publicKey,
      now: T0,
    });
    expect(res).toEqual({ valid: false, reason: "BAD_CERT_CHAIN" });
  });

  it("verifyCertChain returns MALFORMED (not a throw) for junk certs", () => {
    const res = verifyCertChain({
      memberCert: {} as never,
      sarrafCert,
      rootPublicKey: ROOT.publicKey,
      now: T0,
    });
    expect(res).toEqual({ valid: false, reason: "MALFORMED" });
  });

  it("verifyTranscript rejects a cap boundary breach by exactly one unit", () => {
    const cap = DENOMS[2]!;
    const { sarrafCert: sc, memberCert: mc } = certPair({ memberCap: cap - 1n });
    const t = transcriptFor(2, 9);
    const res = verifyTranscript({
      transcript: t,
      memberCert: mc,
      sarrafCert: sc,
      rootPublicKey: ROOT.publicKey,
      now: T0,
      expectedRecipient: RECIPIENT.publicKey,
    });
    expect(res).toEqual({ valid: false, reason: "CAP_EXCEEDED" });
  });
});

describe("ReconcileTracker bookkeeping", () => {
  const batch = batchOf();
  const spendTo = (i: number, recipient: Hex, n: number): Transcript => {
    const invoice = invoiceFor(batch.notes[i]!.value, n, recipient);
    return spendNote({ batch, noteIndex: i, invoice, carver: CARVER });
  };

  it("submitting the same conflicting transcript twice does not duplicate the victim", () => {
    const tracker = new ReconcileTracker();
    tracker.submit(spendTo(0, RECIPIENT.publicKey, 1));
    const conflict = spendTo(0, OTHER.publicKey, 2);
    tracker.submit(structuredClone(conflict));
    const out = tracker.submit(structuredClone(conflict)); // byte-identical conflict replay
    expect(out.status).toBe("duplicate");
    if (out.status === "duplicate") {
      expect(out.conviction.victims).toEqual([OTHER.publicKey]);
    }
  });

  it("isSpent is case-insensitive on the serial", () => {
    const tracker = new ReconcileTracker();
    const t = spendTo(1, RECIPIENT.publicKey, 3);
    tracker.submit(t);
    expect(tracker.isSpent(t.serial.toUpperCase().replace("0X", "0x") as Hex)).toBe(true);
  });

  it("state is independent across tracker instances", () => {
    const a = new ReconcileTracker();
    const b = new ReconcileTracker();
    const t = spendTo(2, RECIPIENT.publicKey, 4);
    a.submit(t);
    expect(b.isSpent(t.serial)).toBe(false);
  });

  it("a throwing submission leaves the tracker fully intact", () => {
    const tracker = new ReconcileTracker();
    const t = spendTo(3, RECIPIENT.publicKey, 5);
    tracker.submit(t);
    const broken = structuredClone(t);
    broken.signature = ("0x" + "00".repeat(64)) as Hex;
    expect(() => tracker.submit(broken)).toThrowError(/BAD_SIGNATURE/);
    expect(tracker.convictions()).toEqual([]);
    // Original remains idempotently re-submittable.
    expect(tracker.submit(structuredClone(t)).status).toBe("accepted");
  });
});
