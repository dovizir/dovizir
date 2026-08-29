"use client";

import { peekCredential } from "../embedded/passkey";
import { hasEmbeddedWallet } from "../embedded/account";

/**
 * Browser-side inputs to the onboarding step machine (steps.mjs). The machine
 * itself is pure and tested standalone; this file is the thin storage edge.
 */
const WELCOMED_STORAGE = "dovizir.onboarding.welcomed";

function ls(): Storage | null {
  return typeof window !== "undefined" ? window.localStorage : null;
}

/** True once the user has passed the one-time "wallet ready" screen. */
export function getWelcomed(): boolean {
  return ls()?.getItem(WELCOMED_STORAGE) === "1";
}

export function setWelcomed(): void {
  ls()?.setItem(WELCOMED_STORAGE, "1");
}

export function clearWelcomed(): void {
  ls()?.removeItem(WELCOMED_STORAGE);
}

/** Wallet material exists on this device — passkey credential OR the legacy
 *  embedded key. Either way the honest offer is "unlock", never "create". */
export function hasStoredWallet(): boolean {
  return !!peekCredential() || hasEmbeddedWallet();
}
