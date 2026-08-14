/**
 * Arm B `@dovizir/notes` entrypoint.
 *
 * The exported surface is exactly the pinned contract in
 * `packages/acceptance/notes/notes-api.d.ts` — ten value exports and eleven
 * type-only exports, no additions, no omissions, no renames. The pinned file is
 * read-only for this story; contract changes escalate to #9.
 */

export { canonicalize } from "./canonical";
export {
  carveBatch,
  createInvoice,
  generateKeyPair,
  hashInvoice,
  issueCert,
  ReconcileTracker,
  spendNote,
  verifyCertChain,
  verifyTranscript,
} from "./notes";
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
  VerifyResult,
} from "./types";
