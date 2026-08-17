/**
 * Compact, bigint-safe serialization for the QR payloads (invoices and
 * transcripts). A transcript is a few hundred bytes → comfortably inside one QR.
 * bigints are tagged so they survive the round trip.
 */
import type { Hex, Invoice, Transcript } from "@dovizir/notes";

const replacer = (_k: string, v: unknown) =>
  typeof v === "bigint" ? { __b: `0x${v.toString(16)}` } : v;

const reviver = (_k: string, v: unknown) =>
  v && typeof v === "object" && "__b" in (v as Record<string, unknown>)
    ? BigInt((v as { __b: string }).__b)
    : v;

export function packInvoice(inv: Invoice): string {
  return `dvz:inv:${JSON.stringify(inv, replacer)}`;
}
export function unpackInvoice(s: string): Invoice {
  const body = s.trim().replace(/^dvz:inv:/, "");
  return JSON.parse(body, reviver) as Invoice;
}

/**
 * The spend QR carries the frozen Transcript (verified offline by the seller)
 * PLUS the on-chain settlement coordinates (Solidity batch root + membership
 * proof) the seller needs to reconcile later — data they cannot reconstruct
 * from the single-serial transcript alone.
 */
export interface SpendBundle {
  t: Transcript;
  r: Hex; // on-chain (Solidity) batch root
  p: Hex[]; // Solidity membership proof for the serial
}

export function packSpend(bundle: SpendBundle): string {
  return `dvz:tx:${JSON.stringify(bundle, replacer)}`;
}
export function unpackSpend(s: string): SpendBundle {
  const body = s.trim().replace(/^dvz:tx:/, "");
  return JSON.parse(body, reviver) as SpendBundle;
}

export function isInvoicePayload(s: string): boolean {
  return s.trim().startsWith("dvz:inv:");
}
export function isTranscriptPayload(s: string): boolean {
  return s.trim().startsWith("dvz:tx:");
}
