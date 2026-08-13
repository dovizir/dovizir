/**
 * @dovizir/notes — REFEREE API (frozen, round 1)
 *
 * Both arms ship a pure-TS package `@dovizir/notes` implementing exactly this
 * surface. Acceptance specs import the implementation via the alias
 * `@dovizir/notes` and test only through it. ESM, Node >=20, no I/O, no
 * chain access — pure logic. Crypto: secp256k1 signatures (@noble/curves or
 * equivalent), keccak-256 hashing. Wire format for transcripts/certs/invoices:
 * deterministic JSON — UTF-8, object keys sorted lexicographically, bigints
 * as 0x-hex strings, byte fields as 0x-hex — hashed/signed over the UTF-8
 * bytes of that canonical serialization.
 *
 * v0 scope: non-blind notes (carver identity is public), one hop, fixed
 * denominations per batch. CFN identity-shares and divisibility are v1.
 *
 * PINNED SEMANTICS (adjudicated 2026-08-13, pre-freeze — see notes/README.md;
 * AMENDED 2026-08-13 post-adversarial-review, §§5–8):
 * - Merkle: commutative sorted-pair keccak256 (OZ MerkleProof-compatible);
 *   single-leaf batch root == leaf with empty proof. (§8: leaf/interior domain
 *   separation is DELIBERATELY NOT added — it would break OZ compatibility and
 *   desync the TS/Solidity pin; accepted as-is, not exploitable in v0.)
 * - Signatures: 64-byte compact r‖s, RFC6979 deterministic, low-s.
 * - Spend signature scope (§5, AMENDED): the carver signs
 *   keccak256(serial ‖ invoiceHash ‖ uint64-be(expiry) ‖ batchRoot). expiry and
 *   batchRoot are SIGNED (previously unsigned); the proof stays unsigned and is
 *   verified against the now-signed batchRoot.
 * - Cert cap chaining (§7): verifyCertChain requires
 *   memberCert.capLimit <= sarrafCert.capLimit, else BAD_CERT_CHAIN.
 * - Expiry boundary (certs AND notes): valid iff now < expiry.
 * - VALUE_MISMATCH means transcript.value != invoice.amount (value-vs-proof
 *   tampering surfaces as BAD_PROOF since the leaf binds the value).
 * - canonicalize: bigint 0n → "0x0" minimal hex; absent optionals omitted;
 *   strings serialized verbatim (§8, AMENDED: hex-looking free text such as a
 *   `memo` is NO LONGER case-folded — byte fields are lowercased at their typed
 *   construction sites, so distinct-case memos never collide).
 * - ReconcileTracker: identity = SIGNED material serial ‖ invoiceHash ‖
 *   signature (§6, AMENDED from "canonical bytes"), so a mutated UNSIGNED field
 *   is idempotent/accepted, never a conviction; invalid submissions throw
 *   Error(reason); conviction.transcripts = [original, current]; value ==
 *   capLimit is allowed.
 */

export type Hex = `0x${string}`;

export interface KeyPair {
  privateKey: Hex; // 32-byte secp256k1 scalar
  publicKey: Hex;  // 33-byte compressed point
}

export interface Note {
  serial: Hex;      // 32 bytes, unique per note: keccak256(batchSalt ‖ index)
  value: bigint;    // IOU units (6 decimals, matching mock USDT)
  index: number;    // position in batch
  proof: Hex[];     // merkle proof of (serial, value) leaf against batchRoot
}

export interface NoteBatch {
  batchRoot: Hex;   // merkle root over leaves keccak256(serial ‖ value)
  batchSalt: Hex;   // 32-byte random salt (carver-generated)
  trancheId: Hex;   // issuer tranche the locked IOUs belong to
  carver: Hex;      // carver's public key
  expiry: number;   // unix seconds
  notes: Note[];
}

export interface Invoice {
  recipient: Hex;   // recipient's public key
  amount: bigint;
  nonce: Hex;       // 32-byte recipient-generated randomness (the challenge)
  memo?: string;
  createdAt: number; // unix seconds
}

export interface Transcript {
  serial: Hex;
  value: bigint;
  batchRoot: Hex;
  proof: Hex[];
  invoiceHash: Hex;   // keccak256(canonical(invoice)) — recipient binding
  invoice: Invoice;   // carried in full so reconciliation is self-contained
  carver: Hex;        // carver public key
  signature: Hex;     // carver secp256k1 sig over
                      // keccak256(serial ‖ invoiceHash ‖ uint64-be(expiry) ‖ batchRoot) (§5)
  expiry: number;     // copied from batch; SIGNED (§5); verifiers reject after this
}

export type CertRole = "sarraf" | "member";

export interface Cert {
  subject: Hex;       // subject public key
  role: CertRole;
  sarraf?: Hex;       // for member certs: sponsoring sarraf's public key
  capLimit: bigint;   // offline cap granted
  expiry: number;     // unix seconds — SHORT-lived; expiry is revocation
  issuer: Hex;        // signer public key (root for sarraf certs, sarraf for member certs)
  signature: Hex;     // issuer sig over keccak256(canonical(cert minus signature))
}

export interface VerifyResult {
  valid: boolean;
  reason?:
    | "BAD_SIGNATURE" | "BAD_PROOF" | "EXPIRED_NOTE" | "EXPIRED_CERT"
    | "BAD_CERT_CHAIN" | "RECIPIENT_MISMATCH" | "VALUE_MISMATCH"
    | "CAP_EXCEEDED" | "MALFORMED";
}

export type ReconcileOutcome =
  | { status: "accepted"; serial: Hex; recipient: Hex; value: bigint }
  | { status: "duplicate"; conviction: Conviction };

export interface Conviction {
  serial: Hex;
  carver: Hex;             // the convicted double-spender's public key
  transcripts: [Transcript, Transcript]; // the two conflicting spends
  victims: Hex[];          // recipients of every conflicting spend after the first
}

// ---- functions ----

export function generateKeyPair(seed?: Hex): KeyPair;

export function carveBatch(args: {
  carver: KeyPair;
  trancheId: Hex;
  denominations: bigint[]; // one note per entry
  expiry: number;
  batchSalt?: Hex;         // injectable for determinism in tests
}): NoteBatch;

export function createInvoice(args: {
  recipient: KeyPair | { publicKey: Hex };
  amount: bigint;
  memo?: string;
  nonce?: Hex;             // injectable for determinism
  createdAt?: number;
}): Invoice;

export function spendNote(args: {
  batch: NoteBatch;
  noteIndex: number;
  invoice: Invoice;
  carver: KeyPair;
}): Transcript;

/** Full offline verification as the RECIPIENT device would run it. */
export function verifyTranscript(args: {
  transcript: Transcript;
  memberCert: Cert;        // carver's member cert
  sarrafCert: Cert;        // sponsoring sarraf's cert
  rootPublicKey: Hex;
  now: number;
  expectedRecipient: Hex;  // verifier's own pubkey — must equal invoice.recipient
}): VerifyResult;

export function issueCert(args: {
  issuer: KeyPair;
  subject: Hex;
  role: CertRole;
  sarraf?: Hex;
  capLimit: bigint;
  expiry: number;
}): Cert;

export function verifyCertChain(args: {
  memberCert: Cert;
  sarrafCert: Cert;
  rootPublicKey: Hex;
  now: number;
}): VerifyResult;

/** In-memory reconciliation state machine (indexer/vault mirror). */
export class ReconcileTracker {
  /** Verifies structure + signature + proof (NOT certs — chain's job), then
   * accepts first-seen serials and convicts on any repeat. Idempotent for
   * byte-identical duplicates of an already-accepted transcript: returns the
   * original accepted outcome (a re-broadcast is not a double-spend). */
  submit(transcript: Transcript): ReconcileOutcome;
  isSpent(serial: Hex): boolean;
  convictions(): Conviction[];
}

export function canonicalize(value: unknown): string; // the deterministic JSON serializer
export function hashInvoice(invoice: Invoice): Hex;
