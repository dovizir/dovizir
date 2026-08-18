/**
 * IndexedDB persistence for the offline-notes device state (idb). Everything a
 * phone would hold locally between sessions: the carver's batches (spendable
 * offline cash), spends the buyer produced, and transcripts a seller accepted
 * offline and still has to reconcile. IndexedDB structured-clone stores the
 * bigint fields of Transcript/Invoice natively.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { NoteBatch, Transcript, Hex } from "@dovizir/notes";

export interface StoredBatch {
  batchRoot: Hex; // key (offline TS root)
  onchainRoot: Hex; // Solidity root carved on-chain
  batch: NoteBatch;
  amount: bigint; // total locked on-chain
  expiry: number;
  carveTxHash?: Hex;
  spentSerials: Hex[]; // serials already spent from this device
  createdAt: number;
}

export interface StoredSpend {
  key: string; // serial:nonce
  transcript: Transcript;
  onchainRoot: Hex;
  proof: Hex[];
  createdAt: number;
}

export type ReceivedStatus = "pending" | "submitted" | "settled" | "convicted";
export interface ReceivedTranscript {
  key: string; // serial:nonce
  transcript: Transcript;
  onchainRoot: Hex; // Solidity batch root for reconcile
  proof: Hex[]; // Solidity membership proof
  status: ReceivedStatus;
  receivedAt: number;
  txHash?: Hex;
  note?: string;
}

interface NotesDB extends DBSchema {
  batches: { key: string; value: StoredBatch };
  sent: { key: string; value: StoredSpend };
  received: { key: string; value: ReceivedTranscript };
}

let dbp: Promise<IDBPDatabase<NotesDB>> | null = null;
function db() {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB unavailable");
  if (!dbp) {
    dbp = openDB<NotesDB>("dovizir-notes", 1, {
      upgrade(d) {
        d.createObjectStore("batches", { keyPath: "batchRoot" });
        d.createObjectStore("sent", { keyPath: "key" });
        d.createObjectStore("received", { keyPath: "key" });
      },
    });
  }
  return dbp;
}

export const spendKey = (serial: Hex, nonce: Hex): string => `${serial}:${nonce}`;

// -------- batches (carver's offline cash) --------
export async function putBatch(b: StoredBatch): Promise<void> {
  (await db()).put("batches", b);
}
export async function listBatches(): Promise<StoredBatch[]> {
  return (await db()).getAll("batches");
}
export async function getBatch(root: Hex): Promise<StoredBatch | undefined> {
  return (await db()).get("batches", root);
}
export async function markSerialSpent(root: Hex, serial: Hex): Promise<void> {
  const b = await getBatch(root);
  if (!b) return;
  if (!b.spentSerials.includes(serial)) b.spentSerials.push(serial);
  await putBatch(b);
}

// -------- sent (buyer's outgoing spends) --------
/**
 * Commit a spend and mark its serial in ONE IndexedDB transaction, so a crash
 * cannot leave the device holding a recorded spend whose serial still looks
 * spendable — that state is a double spend waiting to happen, and the chain
 * seizes the payer's collateral for it. Ordering inside the transaction still
 * marks first, so even a partial flush is safe (see spend-commit.mjs).
 */
export async function commitSpendAtomic(
  batchRoot: Hex,
  serial: Hex,
  spend: StoredSpend,
): Promise<void> {
  const database = await db();
  const tx = database.transaction(["batches", "sent"], "readwrite");
  const batches = tx.objectStore("batches");
  const b = await batches.get(batchRoot);
  if (b && !b.spentSerials.includes(serial)) {
    b.spentSerials.push(serial);
    await batches.put(b);
  }
  await tx.objectStore("sent").put(spend);
  await tx.done;
}

export async function putSpend(s: StoredSpend): Promise<void> {
  (await db()).put("sent", s);
}
export async function listSpends(): Promise<StoredSpend[]> {
  return (await db()).getAll("sent");
}

// -------- received (seller's accepted transcripts) --------
export async function putReceived(r: ReceivedTranscript): Promise<void> {
  (await db()).put("received", r);
}
export async function listReceived(): Promise<ReceivedTranscript[]> {
  return (await db()).getAll("received");
}
export async function updateReceived(
  key: string,
  patch: Partial<ReceivedTranscript>,
): Promise<void> {
  const cur = await (await db()).get("received", key);
  if (!cur) return;
  await (await db()).put("received", { ...cur, ...patch });
}

export async function clearAll(): Promise<void> {
  const d = await db();
  await Promise.all([d.clear("batches"), d.clear("sent"), d.clear("received")]);
}
