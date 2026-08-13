/**
 * Deterministic actor set and happy-path world used across specs.
 *
 * All key pairs are literals derived with noble (keyFromPriv), NOT via the
 * implementation's generateKeyPair — the seed->scalar mapping is deliberately
 * unpinned, so nothing here may depend on it.
 */
import {
  carveBatch,
  createInvoice,
  hashInvoice,
  issueCert,
  spendNote,
  verifyTranscript,
  type Cert,
  type Hex,
  type Invoice,
  type NoteBatch,
  type Transcript,
  type VerifyResult,
} from "@dovizir/notes";
import {
  concatBytes,
  fromHex,
  keccak_256,
  keyFromPriv,
  signDigest,
  toHex,
  u64be,
} from "./helpers";

export const T0 = 1_777_000_000; // fixed "now" for all specs (unix seconds)
export const NOTE_EXPIRY = T0 + 3600;
export const CERT_EXPIRY = T0 + 7200; // fixture certs outlive fixture notes

export const TRANCHE = `0x${"01".repeat(32)}` as Hex;
export const SALT = `0x${"feedface".repeat(8)}` as Hex;

export const DENOMS: bigint[] = [
  5_000_000n, // note 0 — 5.000000 IOU
  5_000_000n, // note 1 — duplicate denomination, distinct serial
  25_000_000n, // note 2
  2_000_000_000n, // note 3 — deliberately above MEMBER_CAP
];

export const MEMBER_CAP = 1_000_000_000n;
export const SARRAF_CAP = 10_000_000_000n;

export const ROOT = keyFromPriv(`0x${"11".repeat(32)}` as Hex);
export const SARRAF = keyFromPriv(`0x${"22".repeat(32)}` as Hex);
export const CARVER = keyFromPriv(`0x${"33".repeat(32)}` as Hex);
export const RECIPIENT = keyFromPriv(`0x${"44".repeat(32)}` as Hex);
export const ROGUE = keyFromPriv(`0x${"55".repeat(32)}` as Hex);
export const RECIPIENT2 = keyFromPriv(`0x${"66".repeat(32)}` as Hex);
export const RECIPIENT3 = keyFromPriv(`0x${"77".repeat(32)}` as Hex);

/** Deterministic 32-byte nonce per test-local index. */
export const nonceAt = (i: number): Hex =>
  `0x${i.toString(16).padStart(64, "0")}` as Hex;

export function makeCerts(): { sarrafCert: Cert; memberCert: Cert } {
  const sarrafCert = issueCert({
    issuer: ROOT,
    subject: SARRAF.publicKey,
    role: "sarraf",
    capLimit: SARRAF_CAP,
    expiry: CERT_EXPIRY,
  });
  const memberCert = issueCert({
    issuer: SARRAF,
    subject: CARVER.publicKey,
    role: "member",
    sarraf: SARRAF.publicKey,
    capLimit: MEMBER_CAP,
    expiry: CERT_EXPIRY,
  });
  return { sarrafCert, memberCert };
}

export function makeBatch(
  over: Partial<Parameters<typeof carveBatch>[0]> = {},
): NoteBatch {
  return carveBatch({
    carver: CARVER,
    trancheId: TRANCHE,
    denominations: DENOMS,
    expiry: NOTE_EXPIRY,
    batchSalt: SALT,
    ...over,
  });
}

export function makeInvoice(
  recipientPub: Hex,
  amount: bigint,
  nonceIndex = 1,
  over: Partial<Parameters<typeof createInvoice>[0]> = {},
): Invoice {
  return createInvoice({
    recipient: { publicKey: recipientPub },
    amount,
    nonce: nonceAt(nonceIndex),
    createdAt: T0 - 100,
    ...over,
  });
}

export interface World {
  sarrafCert: Cert;
  memberCert: Cert;
  batch: NoteBatch;
  invoice: Invoice;
  transcript: Transcript;
}

/** Fully valid chain: ROOT -> SARRAF cert -> CARVER member cert, fresh batch,
 * note 0 spent against RECIPIENT's invoice for exactly the note's value. */
export function makeWorld(): World {
  const { sarrafCert, memberCert } = makeCerts();
  const batch = makeBatch();
  const invoice = makeInvoice(RECIPIENT.publicKey, DENOMS[0]);
  const transcript = spendNote({ batch, noteIndex: 0, invoice, carver: CARVER });
  return { sarrafCert, memberCert, batch, invoice, transcript };
}

/** verifyTranscript with the world's defaults; override any arg per test. */
export function check(
  world: World,
  transcript: Transcript,
  over: Partial<Parameters<typeof verifyTranscript>[0]> = {},
): VerifyResult {
  return verifyTranscript({
    transcript,
    memberCert: world.memberCert,
    sarrafCert: world.sarrafCert,
    rootPublicKey: ROOT.publicKey,
    now: T0,
    expectedRecipient: RECIPIENT.publicKey,
    ...over,
  });
}

/** Referee-side re-signing of a (possibly tampered) transcript with a key we
 * hold — used to isolate single verification failures. Pins the signing rule
 * (§5 amendment): sig over
 * keccak256(serial ‖ invoiceHash ‖ u64be(expiry) ‖ batchRoot), 64-byte compact. */
export function resign(t: Transcript, privKey: Hex): Hex {
  const digest = keccak_256(
    concatBytes(fromHex(t.serial), fromHex(t.invoiceHash), u64be(t.expiry), fromHex(t.batchRoot)),
  );
  return signDigest(privKey, digest);
}

/** Rebuild invoiceHash + signature after swapping the embedded invoice. */
export function rebindInvoice(
  t: Transcript,
  invoice: Invoice,
  signWith: Hex | null,
): Transcript {
  const out = structuredClone(t);
  out.invoice = invoice;
  out.invoiceHash = hashInvoice(invoice);
  if (signWith !== null) out.signature = resign(out, signWith);
  return out;
}

export { toHex };
