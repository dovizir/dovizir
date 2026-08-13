/** Arm A test support: deterministic actors and world builders. */
import {
  carveBatch,
  createInvoice,
  generateKeyPair,
  issueCert,
  spendNote,
  type Cert,
  type Hex,
  type Invoice,
  type KeyPair,
  type NoteBatch,
  type Transcript,
} from "../src/index.js";

export const T0 = 1_900_000_000;
export const NOTE_EXPIRY = T0 + 3_600;
export const CERT_EXPIRY = T0 + 7_200;
export const TRANCHE = `0x${"ab".repeat(32)}` as Hex;
export const SALT = `0x${"5a".repeat(32)}` as Hex;

export const ROOT = generateKeyPair(`0x${"01".repeat(32)}` as Hex);
export const SARRAF = generateKeyPair(`0x${"02".repeat(32)}` as Hex);
export const CARVER = generateKeyPair(`0x${"03".repeat(32)}` as Hex);
export const RECIPIENT = generateKeyPair(`0x${"04".repeat(32)}` as Hex);
export const OTHER = generateKeyPair(`0x${"05".repeat(32)}` as Hex);

export const DENOMS = [1_000_000n, 2_000_000n, 3_000_000n, 4_000_000n, 5_000_000n];

export const nonceAt = (i: number): Hex => `0x${i.toString(16).padStart(64, "0")}` as Hex;

export function certPair(overrides?: { memberCap?: bigint; memberExpiry?: number }): {
  sarrafCert: Cert;
  memberCert: Cert;
} {
  const sarrafCert = issueCert({
    issuer: ROOT,
    subject: SARRAF.publicKey,
    role: "sarraf",
    capLimit: 1_000_000_000n,
    expiry: CERT_EXPIRY,
  });
  const memberCert = issueCert({
    issuer: SARRAF,
    subject: CARVER.publicKey,
    role: "member",
    sarraf: SARRAF.publicKey,
    capLimit: overrides?.memberCap ?? 100_000_000n,
    expiry: overrides?.memberExpiry ?? CERT_EXPIRY,
  });
  return { sarrafCert, memberCert };
}

export function batchOf(denoms: bigint[] = DENOMS, carver: KeyPair = CARVER): NoteBatch {
  return carveBatch({
    carver,
    trancheId: TRANCHE,
    denominations: denoms,
    expiry: NOTE_EXPIRY,
    batchSalt: SALT,
  });
}

export function invoiceFor(amount: bigint, nonceIndex = 1, recipient: Hex = RECIPIENT.publicKey): Invoice {
  return createInvoice({
    recipient: { publicKey: recipient },
    amount,
    nonce: nonceAt(nonceIndex),
    createdAt: T0 - 60,
  });
}

export function transcriptFor(
  noteIndex: number,
  nonceIndex = 1,
  batch: NoteBatch = batchOf(),
): Transcript {
  const invoice = invoiceFor(batch.notes[noteIndex]!.value, nonceIndex);
  return spendNote({ batch, noteIndex, invoice, carver: CARVER });
}

/** Tiny deterministic PRNG for property-style tests (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
