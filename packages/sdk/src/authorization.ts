import type { Hex } from "./addresses";
import { BASE_SEPOLIA_CHAIN_ID } from "./chain";

/**
 * EIP-712 typed data for IouToken.transferWithAuthorization, pinned by the
 * frozen AuthLib spec (packages/acceptance/src/AuthLib.sol):
 * domain name "Dovizir IOU", version "1", chainId, verifyingContract = IouToken.
 * Signature format on-chain: 65-byte r||s||v (viem's signTypedData output).
 */

export const TRANSFER_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "id", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface TransferAuthorization {
  from: Hex;
  to: Hex;
  id: bigint;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/** Random one-time 32-byte nonce (browser / Node 20 WebCrypto). */
export function randomAuthNonce(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/**
 * Builds the full signTypedData payload for a courier-relayable transfer.
 * Default validity window: valid immediately, expires in one hour.
 */
export function buildTransferAuthorization(params: {
  iouToken: Hex;
  from: Hex;
  to: Hex;
  id: bigint;
  amount: bigint;
  validAfter?: bigint;
  validBefore?: bigint;
  nonce?: Hex;
  chainId?: number;
}) {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const message: TransferAuthorization = {
    from: params.from,
    to: params.to,
    id: params.id,
    amount: params.amount,
    // Contract requires block.timestamp > validAfter (strict); backdate 60s.
    validAfter: params.validAfter ?? nowSec - 60n,
    validBefore: params.validBefore ?? nowSec + 3600n,
    nonce: params.nonce ?? randomAuthNonce(),
  };
  return {
    domain: {
      name: "Dovizir IOU",
      version: "1",
      chainId: params.chainId ?? BASE_SEPOLIA_CHAIN_ID,
      verifyingContract: params.iouToken,
    },
    types: TRANSFER_AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  } as const;
}
