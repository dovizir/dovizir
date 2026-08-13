/**
 * Note-side flows: carveBatch, createInvoice, hashInvoice, spendNote.
 */
import { concatBytes, fromHex, isHexBytes, keccak_256, normHex, randomHex, toHex, u32be, u64be } from "./bytes.js";
import { canonicalize, hashCanonical } from "./canonicalize.js";
import { signDigest } from "./crypto.js";
import { buildMerkle, leafOf } from "./merkle.js";
import type { Hex, Invoice, KeyPair, Note, NoteBatch, Transcript } from "./types.js";

export function carveBatch(args: {
  carver: KeyPair;
  trancheId: Hex;
  denominations: bigint[];
  expiry: number;
  batchSalt?: Hex;
}): NoteBatch {
  const { carver, trancheId, denominations, expiry } = args;
  if (!Array.isArray(denominations) || denominations.length === 0) {
    throw new Error("carveBatch: at least one denomination required");
  }
  for (const d of denominations) {
    if (typeof d !== "bigint" || d < 0n) throw new Error("carveBatch: denominations must be non-negative bigints");
  }
  if (!Number.isInteger(expiry)) throw new Error("carveBatch: expiry must be an integer unix time");
  const batchSalt = args.batchSalt !== undefined ? normHex(args.batchSalt) : randomHex(32);
  if (!isHexBytes(batchSalt, 32)) throw new Error("carveBatch: batchSalt must be 32 bytes");

  const saltBytes = fromHex(batchSalt);
  // serial_i = keccak256(batchSalt ‖ uint32-be(i))
  const serials = denominations.map((_, i) => keccak_256(concatBytes(saltBytes, u32be(i))));
  const leaves = denominations.map((value, i) => leafOf(toHex(serials[i]!), value));
  const { root, proofs } = buildMerkle(leaves);

  const notes: Note[] = denominations.map((value, index) => ({
    serial: toHex(serials[index]!),
    value,
    index,
    proof: proofs[index]!.map(toHex),
  }));

  return {
    batchRoot: toHex(root),
    batchSalt,
    trancheId: normHex(trancheId),
    carver: normHex(carver.publicKey),
    expiry,
    notes,
  };
}

export function createInvoice(args: {
  recipient: KeyPair | { publicKey: Hex };
  amount: bigint;
  memo?: string;
  nonce?: Hex;
  createdAt?: number;
}): Invoice {
  if (typeof args.amount !== "bigint" || args.amount < 0n) {
    throw new Error("createInvoice: amount must be a non-negative bigint");
  }
  const nonce = args.nonce !== undefined ? normHex(args.nonce) : randomHex(32);
  const createdAt = args.createdAt ?? Math.floor(Date.now() / 1000);
  const invoice: Invoice = {
    recipient: normHex(args.recipient.publicKey),
    amount: args.amount,
    nonce,
    createdAt,
  };
  if (args.memo !== undefined) invoice.memo = args.memo;
  return invoice;
}

/** keccak256(canonical(invoice)) — the recipient-binding commitment. */
export function hashInvoice(invoice: Invoice): Hex {
  return hashCanonical(invoice);
}

/**
 * The signed spend digest (AMENDED — review §5):
 *   keccak256(serial ‖ invoiceHash ‖ u64be(expiry) ‖ batchRoot).
 * `expiry` and `batchRoot` are now signed so neither the note's freshness nor
 * the batch it belongs to can be swapped after the carver signs (the proof
 * stays unsigned — it is verified against the now-signed batchRoot).
 */
export function spendDigest(
  serial: Hex,
  invoiceHash: Hex,
  expiry: number,
  batchRoot: Hex,
): Uint8Array {
  return keccak_256(
    concatBytes(fromHex(serial), fromHex(invoiceHash), u64be(expiry), fromHex(batchRoot)),
  );
}

export function spendNote(args: {
  batch: NoteBatch;
  noteIndex: number;
  invoice: Invoice;
  carver: KeyPair;
}): Transcript {
  const { batch, noteIndex, invoice, carver } = args;
  const note = batch.notes[noteIndex];
  if (!note) throw new Error(`spendNote: no note at index ${noteIndex}`);
  if (normHex(carver.publicKey) !== normHex(batch.carver)) {
    throw new Error("spendNote: carver key does not match the batch carver");
  }
  const invoiceHash = hashInvoice(invoice);
  const serial = normHex(note.serial);
  const batchRoot = normHex(batch.batchRoot);
  const signature = signDigest(
    carver.privateKey,
    spendDigest(serial, invoiceHash, batch.expiry, batchRoot),
  );
  return {
    serial,
    value: note.value,
    batchRoot,
    proof: note.proof.map((p) => normHex(p)),
    invoiceHash,
    invoice: structuredClone(invoice),
    carver: normHex(carver.publicKey),
    signature,
    expiry: batch.expiry,
  };
}

export { canonicalize };
