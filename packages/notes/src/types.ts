/**
 * Domain types for the Arm B `@dovizir/notes` package.
 *
 * These mirror, name-for-name and field-for-field, the pinned contract at
 * `packages/acceptance/notes/notes-api.d.ts`. That file is read-only for this
 * story; this module exists so the implementation can be written without
 * importing declaration files at runtime.
 */

export type Hex = `0x${string}`;

export interface KeyPair {
  privateKey: Hex;
  publicKey: Hex;
}

export interface Note {
  serial: Hex;
  value: bigint;
  index: number;
  proof: Hex[];
}

export interface NoteBatch {
  batchRoot: Hex;
  batchSalt: Hex;
  trancheId: Hex;
  carver: Hex;
  expiry: number;
  notes: Note[];
}

export interface Invoice {
  recipient: Hex;
  amount: bigint;
  nonce: Hex;
  memo?: string;
  createdAt: number;
}

export interface Transcript {
  serial: Hex;
  value: bigint;
  batchRoot: Hex;
  proof: Hex[];
  invoiceHash: Hex;
  invoice: Invoice;
  carver: Hex;
  signature: Hex;
  expiry: number;
}

export type CertRole = "sarraf" | "member";

export interface Cert {
  subject: Hex;
  role: CertRole;
  sarraf?: Hex;
  capLimit: bigint;
  expiry: number;
  issuer: Hex;
  signature: Hex;
}

export interface VerifyResult {
  valid: boolean;
  reason?:
    | "BAD_SIGNATURE"
    | "BAD_PROOF"
    | "EXPIRED_NOTE"
    | "EXPIRED_CERT"
    | "BAD_CERT_CHAIN"
    | "RECIPIENT_MISMATCH"
    | "VALUE_MISMATCH"
    | "CAP_EXCEEDED"
    | "MALFORMED";
}

export type ReconcileOutcome =
  | { status: "accepted"; serial: Hex; recipient: Hex; value: bigint }
  | { status: "duplicate"; conviction: Conviction };

export interface Conviction {
  serial: Hex;
  carver: Hex;
  transcripts: [Transcript, Transcript];
  victims: Hex[];
}
