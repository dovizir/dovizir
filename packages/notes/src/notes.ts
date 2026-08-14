/**
 * Pure-TS implementation of the pinned `@dovizir/notes` behaviour.
 *
 * Pinned semantics honoured here:
 *  - merkle: commutative sorted-pair keccak256; single-leaf batch root == leaf,
 *    with an empty proof.
 *  - signatures: 64-byte compact r‖s, RFC6979 deterministic, low-s (noble default).
 *  - expiry boundary (certs AND notes): valid iff `now < expiry`.
 *  - VALUE_MISMATCH means `transcript.value != invoice.amount`; tampering with the
 *    value surfaces as BAD_PROOF first, because the leaf binds the value.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { canonicalize, fromHex, isHex, keccak256, toHex, u256, utf8 } from "./canonical";
import type {
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

type Reason = NonNullable<VerifyResult["reason"]>;

const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Entropy is injectable everywhere; this is only the no-seed fallback. */
function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out); // pinned-capability: generateKeyPair/carveBatch/createInvoice accept injected entropy; unseeded calls need a CSPRNG
  return out;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000); // pinned-capability: createInvoice(createdAt?) is optional in the pinned signature
}

function fail(reason: Reason): VerifyResult {
  return { valid: false, reason };
}

function eq(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function compactSignature(signature: unknown): Uint8Array {
  if (signature instanceof Uint8Array) return signature;
  if (typeof signature === "object" && signature !== null && "toCompactRawBytes" in signature) {
    return (signature as { toCompactRawBytes: () => Uint8Array }).toCompactRawBytes();
  }
  throw new Error("MALFORMED");
}

function signDigest(digest: Hex, privateKey: Hex): Hex {
  return toHex(compactSignature(secp256k1.sign(fromHex(digest), fromHex(privateKey))));
}

function verifyDigest(digest: Hex, signature: Hex, publicKey: Hex): boolean {
  try {
    return secp256k1.verify(fromHex(signature), fromHex(digest), fromHex(publicKey)) === true;
  } catch {
    return false;
  }
}

// ---- merkle (commutative sorted-pair keccak256) ----

function leafHash(serial: Hex, value: bigint): Hex {
  return keccak256(fromHex(serial), u256(value));
}

function pairHash(a: Hex, b: Hex): Hex {
  return a.toLowerCase() <= b.toLowerCase()
    ? keccak256(fromHex(a), fromHex(b))
    : keccak256(fromHex(b), fromHex(a));
}

function merkleLayers(leaves: readonly Hex[]): Hex[][] {
  const layers: Hex[][] = [[...leaves]];
  let current: Hex[] = [...leaves];
  while (current.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(i + 1 < current.length ? pairHash(current[i], current[i + 1]) : current[i]);
    }
    layers.push(next);
    current = next;
  }
  return layers;
}

function merkleProof(layers: readonly Hex[][], index: number): Hex[] {
  const proof: Hex[] = [];
  let position = index;
  for (let level = 0; level < layers.length - 1; level += 1) {
    const layer = layers[level];
    const sibling = position % 2 === 0 ? position + 1 : position - 1;
    if (sibling < layer.length) proof.push(layer[sibling]);
    position = Math.floor(position / 2);
  }
  return proof;
}

function verifyProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  let computed = leaf;
  for (const node of proof) computed = pairHash(computed, node);
  return eq(computed, root);
}

// ---- keys, batches, invoices ----

export function generateKeyPair(seed?: Hex): KeyPair {
  const material = seed === undefined ? randomBytes(32) : fromHex(seed);
  const scalarBytes = material.length === 32 ? material : fromHex(keccak256(material));
  const scalar = BigInt(toHex(scalarBytes));
  const normalized =
    scalar > 0n && scalar < CURVE_ORDER ? scalar : (scalar % (CURVE_ORDER - 1n)) + 1n;
  const privateKey = toHex(u256(normalized));
  return { privateKey, publicKey: toHex(secp256k1.getPublicKey(fromHex(privateKey), true)) };
}

export function carveBatch(args: {
  carver: KeyPair;
  trancheId: Hex;
  denominations: bigint[];
  expiry: number;
  batchSalt?: Hex;
}): NoteBatch {
  const { carver, trancheId, denominations, expiry } = args;
  if (!Array.isArray(denominations) || denominations.length === 0) throw new Error("MALFORMED");
  const batchSalt = args.batchSalt ?? toHex(randomBytes(32));
  const saltBytes = fromHex(batchSalt);

  const serials = denominations.map((_value, index) => keccak256(saltBytes, u256(BigInt(index))));
  const leaves = denominations.map((value, index) => leafHash(serials[index], value));
  const layers = merkleLayers(leaves);
  const batchRoot = layers[layers.length - 1][0];

  const notes: Note[] = denominations.map((value, index) => ({
    serial: serials[index],
    value,
    index,
    proof: merkleProof(layers, index),
  }));

  return { batchRoot, batchSalt, trancheId, carver: carver.publicKey, expiry, notes };
}

export function createInvoice(args: {
  recipient: KeyPair | { publicKey: Hex };
  amount: bigint;
  memo?: string;
  nonce?: Hex;
  createdAt?: number;
}): Invoice {
  const invoice: Invoice = {
    recipient: args.recipient.publicKey,
    amount: args.amount,
    nonce: args.nonce ?? toHex(randomBytes(32)),
    createdAt: args.createdAt ?? nowSeconds(),
  };
  return args.memo === undefined ? invoice : { ...invoice, memo: args.memo };
}

export function hashInvoice(invoice: Invoice): Hex {
  return keccak256(utf8(canonicalize(invoice)));
}

function spendDigest(serial: Hex, invoiceHash: Hex): Hex {
  return keccak256(fromHex(serial), fromHex(invoiceHash));
}

export function spendNote(args: {
  batch: NoteBatch;
  noteIndex: number;
  invoice: Invoice;
  carver: KeyPair;
}): Transcript {
  const { batch, noteIndex, invoice, carver } = args;
  const note = batch.notes[noteIndex];
  if (note === undefined) throw new Error("MALFORMED");
  const invoiceHash = hashInvoice(invoice);
  return {
    serial: note.serial,
    value: note.value,
    batchRoot: batch.batchRoot,
    proof: [...note.proof],
    invoiceHash,
    invoice,
    carver: carver.publicKey,
    signature: signDigest(spendDigest(note.serial, invoiceHash), carver.privateKey),
    expiry: batch.expiry,
  };
}

// ---- certs ----

function certDigest(cert: Cert): Hex {
  const unsigned: Record<string, unknown> = {
    subject: cert.subject,
    role: cert.role,
    capLimit: cert.capLimit,
    expiry: cert.expiry,
    issuer: cert.issuer,
  };
  if (cert.sarraf !== undefined) unsigned["sarraf"] = cert.sarraf;
  return keccak256(utf8(canonicalize(unsigned)));
}

export function issueCert(args: {
  issuer: KeyPair;
  subject: Hex;
  role: CertRole;
  sarraf?: Hex;
  capLimit: bigint;
  expiry: number;
}): Cert {
  const unsigned: Cert = {
    subject: args.subject,
    role: args.role,
    capLimit: args.capLimit,
    expiry: args.expiry,
    issuer: args.issuer.publicKey,
    signature: "0x",
    ...(args.sarraf === undefined ? {} : { sarraf: args.sarraf }),
  };
  return { ...unsigned, signature: signDigest(certDigest(unsigned), args.issuer.privateKey) };
}

function certShaped(cert: Cert): boolean {
  return (
    typeof cert === "object" &&
    cert !== null &&
    isHex(cert.subject) &&
    isHex(cert.issuer) &&
    isHex(cert.signature) &&
    (cert.role === "sarraf" || cert.role === "member") &&
    typeof cert.capLimit === "bigint" &&
    typeof cert.expiry === "number" &&
    (cert.sarraf === undefined || isHex(cert.sarraf))
  );
}

export function verifyCertChain(args: {
  memberCert: Cert;
  sarrafCert: Cert;
  rootPublicKey: Hex;
  now: number;
}): VerifyResult {
  const { memberCert, sarrafCert, rootPublicKey, now } = args;
  if (!certShaped(memberCert) || !certShaped(sarrafCert) || !isHex(rootPublicKey)) {
    return fail("MALFORMED");
  }
  if (sarrafCert.role !== "sarraf" || memberCert.role !== "member") return fail("BAD_CERT_CHAIN");
  if (!eq(sarrafCert.issuer, rootPublicKey)) return fail("BAD_CERT_CHAIN");
  if (!eq(memberCert.issuer, sarrafCert.subject)) return fail("BAD_CERT_CHAIN");
  if (memberCert.sarraf === undefined || !eq(memberCert.sarraf, sarrafCert.subject)) {
    return fail("BAD_CERT_CHAIN");
  }
  if (!verifyDigest(certDigest(sarrafCert), sarrafCert.signature, rootPublicKey)) {
    return fail("BAD_SIGNATURE");
  }
  if (!verifyDigest(certDigest(memberCert), memberCert.signature, sarrafCert.subject)) {
    return fail("BAD_SIGNATURE");
  }
  if (!(now < sarrafCert.expiry) || !(now < memberCert.expiry)) return fail("EXPIRED_CERT");
  return { valid: true };
}

// ---- transcripts ----

function transcriptShaped(transcript: Transcript): boolean {
  return (
    typeof transcript === "object" &&
    transcript !== null &&
    isHex(transcript.serial) &&
    isHex(transcript.batchRoot) &&
    isHex(transcript.carver) &&
    isHex(transcript.signature) &&
    isHex(transcript.invoiceHash) &&
    typeof transcript.value === "bigint" &&
    typeof transcript.expiry === "number" &&
    Array.isArray(transcript.proof) &&
    transcript.proof.every((node) => isHex(node)) &&
    typeof transcript.invoice === "object" &&
    transcript.invoice !== null &&
    isHex(transcript.invoice.recipient) &&
    isHex(transcript.invoice.nonce) &&
    typeof transcript.invoice.amount === "bigint" &&
    eq(transcript.invoiceHash, hashInvoice(transcript.invoice))
  );
}

/** Signature + proof, i.e. everything a reconciler can check without certs. */
function transcriptCryptoFault(transcript: Transcript): Reason | null {
  if (
    !verifyDigest(
      spendDigest(transcript.serial, transcript.invoiceHash),
      transcript.signature,
      transcript.carver,
    )
  ) {
    return "BAD_SIGNATURE";
  }
  if (!verifyProof(leafHash(transcript.serial, transcript.value), transcript.proof, transcript.batchRoot)) {
    return "BAD_PROOF";
  }
  return null;
}

export function verifyTranscript(args: {
  transcript: Transcript;
  memberCert: Cert;
  sarrafCert: Cert;
  rootPublicKey: Hex;
  now: number;
  expectedRecipient: Hex;
}): VerifyResult {
  const { transcript, memberCert, sarrafCert, rootPublicKey, now, expectedRecipient } = args;
  if (!transcriptShaped(transcript) || !isHex(expectedRecipient)) return fail("MALFORMED");

  const chain = verifyCertChain({ memberCert, sarrafCert, rootPublicKey, now });
  if (!chain.valid) return chain;
  if (!eq(memberCert.subject, transcript.carver)) return fail("BAD_CERT_CHAIN");
  if (!(now < transcript.expiry)) return fail("EXPIRED_NOTE");
  if (!eq(transcript.invoice.recipient, expectedRecipient)) return fail("RECIPIENT_MISMATCH");

  const fault = transcriptCryptoFault(transcript);
  if (fault !== null) return fail(fault);

  if (transcript.value !== transcript.invoice.amount) return fail("VALUE_MISMATCH");
  if (transcript.value > memberCert.capLimit) return fail("CAP_EXCEEDED");
  return { valid: true };
}

// ---- reconciliation ----

interface AcceptedEntry {
  transcript: Transcript;
  canonical: string;
  outcome: ReconcileOutcome;
}

/** In-memory reconciliation state machine (indexer/vault mirror). */
export class ReconcileTracker {
  readonly #accepted = new Map<string, AcceptedEntry>();
  readonly #convictions = new Map<string, Conviction>();

  submit(transcript: Transcript): ReconcileOutcome {
    if (!transcriptShaped(transcript)) throw new Error("MALFORMED");
    const fault = transcriptCryptoFault(transcript);
    if (fault !== null) throw new Error(fault);

    const key = transcript.serial.toLowerCase();
    const canonical = canonicalize(transcript);
    const existing = this.#accepted.get(key);

    if (existing === undefined) {
      const outcome: ReconcileOutcome = {
        status: "accepted",
        serial: transcript.serial,
        recipient: transcript.invoice.recipient,
        value: transcript.value,
      };
      this.#accepted.set(key, { transcript, canonical, outcome });
      return outcome;
    }

    // A byte-identical re-broadcast of an accepted transcript is not a double-spend.
    if (existing.canonical === canonical) return existing.outcome;

    const prior = this.#convictions.get(key);
    const victims =
      prior === undefined
        ? [transcript.invoice.recipient]
        : [...prior.victims, transcript.invoice.recipient];
    const conviction: Conviction = {
      serial: existing.transcript.serial,
      carver: existing.transcript.carver,
      transcripts: [existing.transcript, transcript],
      victims,
    };
    this.#convictions.set(key, conviction);
    return { status: "duplicate", conviction };
  }

  isSpent(serial: Hex): boolean {
    return this.#accepted.has(serial.toLowerCase());
  }

  convictions(): Conviction[] {
    return [...this.#convictions.values()];
  }
}
