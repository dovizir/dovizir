"use client";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

/**
 * Embedded wallet key material (PoC stepping stone).
 *
 * The target audience won't have a Base wallet, so Dovizir creates one FOR the
 * user — no "Connect wallet", no seed phrase. This PoC keeps a locally-generated
 * key in localStorage so the whole app works today on testnet.
 *
 * ⚠️ NOT production key management: a raw key in localStorage is XSS-exposed and
 * not recoverable across devices. The production upgrade (same wagmi seam) swaps
 * this for an ERC-4337 smart account whose owner is a PASSKEY (WebAuthn P-256,
 * hardware-backed, non-extractable) with the joined Sarraf's paymaster
 * sponsoring gas. See lib/embedded/connector.ts and the AA-SEAM notes.
 */
const KEY_STORAGE = "dovizir.embedded.pk";
const SARRAF_STORAGE = "dovizir.embedded.sarraf";

function ls(): Storage | null {
  return typeof window !== "undefined" ? window.localStorage : null;
}

export function hasEmbeddedWallet(): boolean {
  return !!ls()?.getItem(KEY_STORAGE);
}

/** Returns the stored key, or creates + persists a fresh one on first use. */
export function getOrCreatePrivateKey(): Hex {
  const store = ls();
  if (!store) throw new Error("embedded wallet requires a browser");
  let pk = store.getItem(KEY_STORAGE) as Hex | null;
  if (!pk) {
    pk = generatePrivateKey();
    store.setItem(KEY_STORAGE, pk);
  }
  return pk;
}

export function getEmbeddedAccount() {
  return privateKeyToAccount(getOrCreatePrivateKey());
}

/** Address without creating a wallet if none exists (returns null instead). */
export function peekEmbeddedAddress(): Hex | null {
  const pk = ls()?.getItem(KEY_STORAGE) as Hex | null;
  return pk ? privateKeyToAccount(pk).address : null;
}

export function clearEmbeddedWallet(): void {
  ls()?.removeItem(KEY_STORAGE);
  ls()?.removeItem(SARRAF_STORAGE);
}

/** The Sarraf a customer onboarded through — drives IOU tranche + (later) the
 *  paymaster that sponsors this user's gas. */
export function setJoinedSarraf(address: Hex): void {
  ls()?.setItem(SARRAF_STORAGE, address);
}

export function getJoinedSarraf(): Hex | null {
  return (ls()?.getItem(SARRAF_STORAGE) as Hex | null) ?? null;
}
