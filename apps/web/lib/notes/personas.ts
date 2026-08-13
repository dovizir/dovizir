/**
 * Demo cast for the offline-notes (M4) flows.
 *
 * Each persona carries TWO identities that the bridge ties together by the
 * shared note serial / amount / expiry:
 *   - an OFFLINE secp256k1 KeyPair (the frozen @dovizir/notes identity used for
 *     invoices, spend signatures and offline verification);
 *   - an ON-CHAIN anvil account (address + key) used for NoteVault settlement.
 *
 * The anvil private keys below are the PUBLIC, well-known Foundry dev keys —
 * safe to embed because this v0 demo settles only against a local anvil. This
 * is the "hold a key to raw-sign the on-chain spend digest" seam: a production
 * build routes signing through the member's smart account (AA-SEAM), never an
 * embedded key.
 */
import { privateKeyToAccount } from "viem/accounts";
import {
  generateKeyPair,
  issueCert,
  type Cert,
  type Hex,
  type KeyPair,
} from "@dovizir/notes";

export interface Persona {
  id: "carver" | "seller1" | "seller2";
  /** offline secp256k1 identity (compressed pubkey) */
  offline: KeyPair;
  /** on-chain anvil account */
  address: Hex;
  privateKey: Hex;
}

// Foundry anvil deterministic accounts (public dev keys).
const ANVIL = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  sarraf: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  carver: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  seller1: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  seller2: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  redeemer: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
} as const;

export const ANVIL_KEYS = ANVIL;

const addressOf = (pk: string) => privateKeyToAccount(pk as Hex).address;

export const SARRAF_ADDRESS = addressOf(ANVIL.sarraf);
export const DEPLOYER_ADDRESS = addressOf(ANVIL.deployer);
/** trancheId = uint256(uint160(sarraf)) — the notes lock in this tranche. */
export const TRANCHE_ID = BigInt(SARRAF_ADDRESS);

// Offline identities (deterministic so the demo is reproducible).
const rootK = generateKeyPair("0x01");
const sarrafK = generateKeyPair("0x05");
const carverK = generateKeyPair("0x02");
const seller1K = generateKeyPair("0x03");
const seller2K = generateKeyPair("0x04");

export const ROOT_PUBLIC_KEY = rootK.publicKey;

/** Offline cap granted by the cert chain (mirrors NoteVault BASE_CAP). */
export const OFFLINE_CAP = 100_000_000000n;

// Short-lived certs; regenerated per session (expiry IS revocation).
const CERT_TTL = 400 * 24 * 3600;
function buildCerts(now: number): { sarrafCert: Cert; memberCert: Cert } {
  const expiry = now + CERT_TTL;
  const sarrafCert = issueCert({
    issuer: rootK,
    subject: sarrafK.publicKey,
    role: "sarraf",
    capLimit: OFFLINE_CAP,
    expiry,
  });
  const memberCert = issueCert({
    issuer: sarrafK,
    subject: carverK.publicKey,
    role: "member",
    sarraf: sarrafK.publicKey,
    capLimit: OFFLINE_CAP,
    expiry,
  });
  return { sarrafCert, memberCert };
}

export const CERTS = buildCerts(Math.floor(Date.now() / 1000));

export const CARVER: Persona = {
  id: "carver",
  offline: carverK,
  address: addressOf(ANVIL.carver),
  privateKey: ANVIL.carver as Hex,
};
export const SELLER1: Persona = {
  id: "seller1",
  offline: seller1K,
  address: addressOf(ANVIL.seller1),
  privateKey: ANVIL.seller1 as Hex,
};
export const SELLER2: Persona = {
  id: "seller2",
  offline: seller2K,
  address: addressOf(ANVIL.seller2),
  privateKey: ANVIL.seller2 as Hex,
};

export const SELLERS = [SELLER1, SELLER2];
export const ALL_PERSONAS = [CARVER, SELLER1, SELLER2];

/** Resolve an offline pubkey (an invoice recipient) back to its on-chain address. */
export function addressForPubkey(pubkey: Hex): Hex | undefined {
  return ALL_PERSONAS.find(
    (p) => p.offline.publicKey.toLowerCase() === pubkey.toLowerCase(),
  )?.address;
}

export function personaForPubkey(pubkey: Hex): Persona | undefined {
  return ALL_PERSONAS.find(
    (p) => p.offline.publicKey.toLowerCase() === pubkey.toLowerCase(),
  );
}

export function shortHex(h: string, lead = 6, tail = 4): string {
  return h.length > lead + tail + 2 ? `${h.slice(0, lead)}…${h.slice(-tail)}` : h;
}
