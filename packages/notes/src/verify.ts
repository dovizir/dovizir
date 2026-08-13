/**
 * Full offline transcript verification as the RECIPIENT device runs it.
 * Check order (each referee reason reachable by exactly one deviation):
 *   MALFORMED (structure; never throws) ->
 *   cert chain (BAD_SIGNATURE / EXPIRED_CERT / BAD_CERT_CHAIN) ->
 *   carver is the member cert's subject (BAD_CERT_CHAIN) ->
 *   note freshness, valid iff now < expiry (EXPIRED_NOTE) ->
 *   invoiceHash consistency (MALFORMED — hash does not commit the invoice) ->
 *   carver signature over keccak256(serial ‖ invoiceHash) (BAD_SIGNATURE) ->
 *   merkle proof of (serial, value) against batchRoot (BAD_PROOF) ->
 *   recipient binding (RECIPIENT_MISMATCH) ->
 *   value == invoice.amount (VALUE_MISMATCH, referee pin #7) ->
 *   value <= capLimit, boundary allowed (CAP_EXCEEDED, referee pin #8).
 */
import { isHexBytes } from "./bytes.js";
import { certShapeValid, verifyCertChain } from "./certs.js";
import { isCompressedPoint, verifyDigest } from "./crypto.js";
import { buildLeafAndVerify } from "./verify-proof.js";
import { hashInvoice, spendDigest } from "./notes.js";
import type { Cert, Hex, Invoice, Transcript, VerifyResult } from "./types.js";

const bad = (reason: NonNullable<VerifyResult["reason"]>): VerifyResult => ({ valid: false, reason });

export function invoiceShapeValid(invoice: unknown): invoice is Invoice {
  if (typeof invoice !== "object" || invoice === null) return false;
  const i = invoice as Partial<Invoice>;
  return (
    isCompressedPoint(i.recipient) &&
    typeof i.amount === "bigint" &&
    i.amount >= 0n &&
    isHexBytes(i.nonce, 32) &&
    (i.memo === undefined || typeof i.memo === "string") &&
    typeof i.createdAt === "number" &&
    Number.isFinite(i.createdAt)
  );
}

export function transcriptShapeValid(t: unknown): t is Transcript {
  if (typeof t !== "object" || t === null) return false;
  const x = t as Partial<Transcript>;
  return (
    isHexBytes(x.serial, 32) &&
    typeof x.value === "bigint" &&
    x.value >= 0n &&
    isHexBytes(x.batchRoot, 32) &&
    Array.isArray(x.proof) &&
    x.proof.every((p) => isHexBytes(p, 32)) &&
    isHexBytes(x.invoiceHash, 32) &&
    invoiceShapeValid(x.invoice) &&
    isCompressedPoint(x.carver) &&
    isHexBytes(x.signature, 64) &&
    typeof x.expiry === "number" &&
    Number.isFinite(x.expiry)
  );
}

export function verifyTranscript(args: {
  transcript: Transcript;
  memberCert: Cert;
  sarrafCert: Cert;
  rootPublicKey: Hex;
  now: number;
  expectedRecipient: Hex;
}): VerifyResult {
  try {
    const { transcript: t, memberCert, sarrafCert, rootPublicKey, now, expectedRecipient } = args;
    if (
      !transcriptShapeValid(t) ||
      !certShapeValid(memberCert) ||
      !certShapeValid(sarrafCert) ||
      !isCompressedPoint(expectedRecipient) ||
      typeof now !== "number" ||
      !Number.isFinite(now)
    ) {
      return bad("MALFORMED");
    }

    const chain = verifyCertChain({ memberCert, sarrafCert, rootPublicKey, now });
    if (!chain.valid) return chain;
    if (t.carver.toLowerCase() !== memberCert.subject.toLowerCase()) return bad("BAD_CERT_CHAIN");

    if (now >= t.expiry) return bad("EXPIRED_NOTE");

    if (hashInvoice(t.invoice).toLowerCase() !== t.invoiceHash.toLowerCase()) {
      // The carried invoice is not the one the hash commits to.
      return bad("MALFORMED");
    }

    if (!verifyDigest(t.signature, spendDigest(t.serial, t.invoiceHash), t.carver)) {
      return bad("BAD_SIGNATURE");
    }

    if (!buildLeafAndVerify(t.serial, t.value, t.proof, t.batchRoot)) return bad("BAD_PROOF");

    if (t.invoice.recipient.toLowerCase() !== expectedRecipient.toLowerCase()) {
      return bad("RECIPIENT_MISMATCH");
    }

    if (t.value !== t.invoice.amount) return bad("VALUE_MISMATCH");

    if (t.value > memberCert.capLimit) return bad("CAP_EXCEEDED");

    return { valid: true };
  } catch {
    return bad("MALFORMED");
  }
}
