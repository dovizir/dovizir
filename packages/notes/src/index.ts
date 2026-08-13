/**
 * @dovizir/notes — Arm A implementation of the frozen referee API
 * (packages/acceptance/notes/notes-api.d.ts). Pure ESM logic: secp256k1
 * (@noble/curves), keccak-256 (@noble/hashes), no I/O, no chain access.
 */
export type {
  Cert,
  CertRole,
  Conviction,
  Hex,
  Invoice,
  KeyPair,
  Note,
  NoteBatch,
  ReconcileOutcome,
  Transcript,
  VerifyReason,
  VerifyResult,
} from "./types.js";

export { canonicalize } from "./canonicalize.js";
export { generateKeyPair } from "./crypto.js";
export { carveBatch, createInvoice, hashInvoice, spendNote } from "./notes.js";
export { issueCert, verifyCertChain } from "./certs.js";
export { verifyTranscript } from "./verify.js";
export { ReconcileTracker } from "./tracker.js";
