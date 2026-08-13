/**
 * Area 10 — wire-format goldens: committed byte-exact expectations built with
 * @noble (see tools/gen-goldens.mjs), never from any implementation. Both arms
 * must converge on these exact bytes.
 *
 * Each block first re-derives the golden from noble primitives in-test (so a
 * stale/hand-edited golden file cannot silently pass), then pins the
 * implementation's output to the golden hex verbatim.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  carveBatch,
  createInvoice,
  hashInvoice,
  issueCert,
  spendNote,
  type Hex,
} from "@dovizir/notes";
import certGolden from "../goldens/cert.golden.json";
import invoiceGolden from "../goldens/invoice.golden.json";
import transcriptGolden from "../goldens/transcript.golden.json";
import {
  concatBytes,
  fromHex,
  keccakHex,
  keyFromPriv,
  sigValid,
  toHex,
  utf8,
} from "./support/helpers";

// Constants mirror tools/gen-goldens.mjs — regenerate goldens if these change.
const SARRAF = keyFromPriv(`0x${"22".repeat(32)}` as Hex);
const CARVER = keyFromPriv(`0x${"33".repeat(32)}` as Hex);
const RECIPIENT = keyFromPriv(`0x${"44".repeat(32)}` as Hex);
const TRANCHE = `0x${"01".repeat(32)}` as Hex;
const SALT = `0x${"feedface".repeat(8)}` as Hex;
const NOTE_EXPIRY = 1_777_003_600;
const CERT_EXPIRY = 1_777_007_200;

const goldenInvoiceArgs = {
  recipient: { publicKey: RECIPIENT.publicKey },
  amount: BigInt(invoiceGolden.inputs.amount),
  nonce: invoiceGolden.inputs.nonce as Hex,
  memo: invoiceGolden.inputs.memo,
  createdAt: invoiceGolden.inputs.createdAt,
};

describe("golden: canonical invoice", () => {
  it("golden file is self-consistent under noble keccak (not implementation-derived)", () => {
    expect(keccakHex(utf8(invoiceGolden.canonical))).toBe(invoiceGolden.hash);
    expect(invoiceGolden.inputs.recipient).toBe(RECIPIENT.publicKey);
  });

  it("implementation canonicalizes the golden invoice to the exact golden bytes", () => {
    const invoice = createInvoice(goldenInvoiceArgs);
    expect(canonicalize(invoice)).toBe(invoiceGolden.canonical);
  });

  it("implementation hashInvoice equals the golden hash verbatim", () => {
    const invoice = createInvoice(goldenInvoiceArgs);
    expect(hashInvoice(invoice).toLowerCase()).toBe(invoiceGolden.hash);
  });
});

describe("golden: canonical cert", () => {
  it("golden file is self-consistent: digest = keccak(utf8(preimage)), sig verifies for issuer", () => {
    expect(keccakHex(utf8(certGolden.preimage))).toBe(certGolden.digest);
    expect(sigValid(certGolden.signature, fromHex(certGolden.digest), SARRAF.publicKey)).toBe(true);
  });

  it("issueCert reproduces the golden preimage and byte-exact deterministic signature", () => {
    const cert = issueCert({
      issuer: SARRAF,
      subject: CARVER.publicKey,
      role: "member",
      sarraf: SARRAF.publicKey,
      capLimit: BigInt(certGolden.inputs.capLimit),
      expiry: CERT_EXPIRY,
    });
    const { signature, ...unsigned } = cert;
    expect(canonicalize(unsigned)).toBe(certGolden.preimage);
    // PINNED signature scheme: RFC6979 deterministic, low-s, 64-byte compact.
    expect(signature.toLowerCase()).toBe(certGolden.signature);
  });
});

describe("golden: transcript-hash preimage", () => {
  const denominations = transcriptGolden.inputs.denominations.map(BigInt);

  it("golden file is self-consistent under noble keccak", () => {
    expect(keccakHex(fromHex(transcriptGolden.sigPreimage))).toBe(transcriptGolden.sigDigest);
    expect(
      toHex(concatBytes(fromHex(transcriptGolden.serials[0]), fromHex(transcriptGolden.invoiceHash))),
    ).toBe(transcriptGolden.sigPreimage);
    expect(transcriptGolden.invoiceHash).toBe(invoiceGolden.hash);
    expect(sigValid(transcriptGolden.signature, fromHex(transcriptGolden.sigDigest), CARVER.publicKey)).toBe(true);
  });

  it("carveBatch reproduces the golden serials and batchRoot byte-for-byte", () => {
    const batch = carveBatch({
      carver: CARVER,
      trancheId: TRANCHE,
      denominations,
      expiry: NOTE_EXPIRY,
      batchSalt: SALT,
    });
    expect(batch.notes.map((n) => n.serial.toLowerCase())).toEqual(transcriptGolden.serials);
    expect(batch.batchRoot.toLowerCase()).toBe(transcriptGolden.batchRoot);
  });

  it("spendNote reproduces the golden invoiceHash and byte-exact carver signature", () => {
    const batch = carveBatch({
      carver: CARVER,
      trancheId: TRANCHE,
      denominations,
      expiry: NOTE_EXPIRY,
      batchSalt: SALT,
    });
    const invoice = createInvoice(goldenInvoiceArgs);
    const t = spendNote({ batch, noteIndex: 0, invoice, carver: CARVER });
    expect(t.serial.toLowerCase()).toBe(transcriptGolden.serials[0]);
    expect(t.invoiceHash.toLowerCase()).toBe(transcriptGolden.invoiceHash);
    expect(t.signature.toLowerCase()).toBe(transcriptGolden.signature);
  });
});
