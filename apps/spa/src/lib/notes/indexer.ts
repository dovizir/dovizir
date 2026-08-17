/**
 * Thin client for the indexer's offline-note endpoints. The "online seller
 * checks a note" path: POST a pending transcript, then poll its status as the
 * on-chain event indexes (pending → spent+outcome).
 */
import type { Hex, Transcript } from "@dovizir/notes";

export function indexerUrl(): string {
  return process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://127.0.0.1:8787";
}

/** Serialize a transcript (bigints → 0x-hex) for the indexer payload. */
function encodePayload(t: Transcript): string {
  return JSON.stringify(t, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v));
}

export interface SerialStatus {
  serial: Hex;
  status: "pending" | "spent" | "unknown";
  outcome?: "settled" | "convicted" | string;
  [k: string]: unknown;
}

export async function submitPending(serial: Hex, transcript: Transcript): Promise<SerialStatus> {
  const res = await fetch(`${indexerUrl()}/serials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serial: serial.toLowerCase(), payload: encodePayload(transcript) }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`indexer ${res.status}`);
  return res.json();
}

export async function serialStatus(serial: Hex): Promise<SerialStatus> {
  const res = await fetch(`${indexerUrl()}/serials/${serial.toLowerCase()}`);
  if (!res.ok) throw new Error(`indexer ${res.status}`);
  return res.json();
}

export async function pendingFeed(): Promise<{ pending: unknown[] }> {
  const res = await fetch(`${indexerUrl()}/serials/pending`);
  if (!res.ok) throw new Error(`indexer ${res.status}`);
  return res.json();
}
