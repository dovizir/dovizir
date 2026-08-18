"use client";

import { createPublicClient, http, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import {
  createWebAuthnCredential,
  toWebAuthnAccount,
  toCoinbaseSmartAccount,
} from "viem/account-abstraction";
import { getRpcUrl } from "@dovizir/sdk";

/**
 * Passkey-owned smart account — the production replacement for the raw key in
 * localStorage (see account.ts).
 *
 * What changes for the user: nothing visible. There is still no seed phrase and
 * no "connect wallet". What changes underneath is that the signing key is a
 * WebAuthn P-256 credential held by the device's secure element — it is
 * NON-EXTRACTABLE, so an XSS bug can no longer walk off with the key, and the
 * device's own biometric gate stands in front of every signature.
 *
 * The account is a Coinbase Smart Wallet, chosen because it verifies P-256
 * signatures on-chain natively; most 4337 accounts assume a secp256k1 owner and
 * would need a separate verifier contract.
 *
 * Recovery is deliberately NOT solved here. A passkey is bound to a device (or
 * to a platform's sync), so losing the device without a recovery path loses the
 * account. That is Phase 5 / G9, and it is a security-sensitive flow: whoever
 * can restore an account must not be able to spend from it.
 */

const CREDENTIAL_STORAGE = "dovizir.passkey.credential";

/** The stored public half of a credential. Never the private key — that never
 *  leaves the secure element, which is the entire point. */
export type StoredCredential = {
  id: string;
  publicKey: Hex;
};

function ls(): Storage | null {
  return typeof window !== "undefined" ? window.localStorage : null;
}

/** True when the browser can do WebAuthn at all. Callers must degrade rather
 *  than fail: an old device still deserves a working wallet. */
export function supportsPasskeys(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    !!navigator.credentials
  );
}

export function peekCredential(): StoredCredential | null {
  const raw = ls()?.getItem(CREDENTIAL_STORAGE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredCredential;
  } catch {
    return null;
  }
}

/**
 * Create a passkey. Triggers the platform prompt (Face ID / fingerprint / PIN).
 * `name` is what the user sees in their password manager, so it should read as
 * an account, not as a technical identifier.
 */
export async function createCredential(name = "Dovizir"): Promise<StoredCredential> {
  if (!supportsPasskeys()) throw new Error("passkeys-unsupported");
  const credential = await createWebAuthnCredential({ name });
  const stored: StoredCredential = {
    id: credential.id,
    publicKey: credential.publicKey,
  };
  ls()?.setItem(CREDENTIAL_STORAGE, JSON.stringify(stored));
  return stored;
}

/**
 * Build the smart account for a stored credential.
 *
 * The address is DERIVED from the credential's public key, not stored, so the
 * same passkey always yields the same account — which is what makes the passkey
 * the thing worth backing up rather than a key we hand the user.
 */
export async function getSmartAccount(credential: StoredCredential) {
  const owner = toWebAuthnAccount({
    credential: { id: credential.id, publicKey: credential.publicKey },
  });
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(getRpcUrl()),
  });
  return toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1" });
}

export function clearCredential(): void {
  ls()?.removeItem(CREDENTIAL_STORAGE);
}
