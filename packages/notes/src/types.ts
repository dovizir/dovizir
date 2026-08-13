/**
 * @dovizir/notes — public types, mirroring the frozen referee API
 * (packages/acceptance/notes/notes-api.d.ts) exactly.
 *
 * v0 scope: non-blind notes (carver identity public), one hop, fixed
 * denominations per batch.
 */

export type Hex = `0x${string}`;

export interface KeyPair {
  privateKey: Hex; // 32-byte secp256k1 scalar
  publicKey: Hex; // 33-byte compressed point
}

export interface Note {
  serial: Hex; // 32 bytes, unique per note: keccak256(batchSalt ‖ index)
  value: bigint; // IOU units (6 decimals, matching mock USDT)
  index: number; // position in batch
  proof: Hex[]; // merkle proof of (serial, value) leaf against batchRoot
}

export interface NoteBatch {
  batchRoot: Hex; // merkle root over leaves keccak256(serial ‖ value)
  batchSalt: Hex; // 32-byte random salt (carver-generated)
  trancheId: Hex; // issuer tranche the locked IOUs belong to
  carver: Hex; // carver's public key
  expiry: number; // unix seconds
  notes: Note[];
}

export interface Invoice {
  recipient: Hex; // recipient's public key
  amount: bigint;
  nonce: Hex; // 32-byte recipient-generated randomness (the challenge)
  memo?: string;
  createdAt: number; // unix seconds
}

export interface Transcript {
  serial: Hex;
  value: bigint;
  batchRoot: Hex;
  proof: Hex[];
  invoiceHash: Hex; // keccak256(canonical(invoice)) — recipient binding
  invoice: Invoice; // carried in full so reconciliation is self-contained
  carver: Hex; // carver public key
  signature: Hex; // carver sig over keccak256(serial ‖ invoiceHash ‖ u64be(expiry) ‖ batchRoot) (§5)
  expiry: number; // copied from batch; SIGNED (§5); verifiers reject after this
}

export type CertRole = "sarraf" | "member";

export interface Cert {
  subject: Hex; // subject public key
  role: CertRole;
  sarraf?: Hex; // for member certs: sponsoring sarraf's public key
  capLimit: bigint; // offline cap granted
  expiry: number; // unix seconds — SHORT-lived; expiry is revocation
  issuer: Hex; // signer public key (root for sarraf certs, sarraf for member certs)
  signature: Hex; // issuer sig over keccak256(canonical(cert minus signature))
}

export type VerifyReason =
  | "BAD_SIGNATURE"
  | "BAD_PROOF"
  | "EXPIRED_NOTE"
  | "EXPIRED_CERT"
  | "BAD_CERT_CHAIN"
  | "RECIPIENT_MISMATCH"
  | "VALUE_MISMATCH"
  | "CAP_EXCEEDED"
  | "MALFORMED";

export interface VerifyResult {
  valid: boolean;
  reason?: VerifyReason;
}

export type ReconcileOutcome =
  | { status: "accepted"; serial: Hex; recipient: Hex; value: bigint }
  | { status: "duplicate"; conviction: Conviction };

export interface Conviction {
  serial: Hex;
  carver: Hex; // the convicted double-spender's public key
  transcripts: [Transcript, Transcript]; // the two conflicting spends
  victims: Hex[]; // recipients of every conflicting spend after the first
}
