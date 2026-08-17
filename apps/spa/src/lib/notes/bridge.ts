/**
 * The TS-offline ↔ on-chain bridge.
 *
 * The frozen @dovizir/notes wire format and the frozen on-chain TranscriptLib
 * encoding are DELIBERATELY different (see TranscriptLib.sol header: "NoteVault
 * verifies its own on-chain encoding"). They share the note serial, the carver
 * key, the amount and the expiry — everything the vault needs to settle. These
 * helpers re-encode an offline spend into the exact bytes NoteVault.reconcile
 * verifies: EIP-712-style invoice hash, packed spend digest, abi-encoded
 * transcript, Solidity sorted-pair merkle proof, and a 65-byte {r,s,v} sig.
 */
import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseAbiParameters,
  toBytes,
  type Hex,
} from "viem";
import { sign, signatureToHex } from "viem/accounts";

export const INVOICE_TYPEHASH = keccak256(
  toBytes("DovizirInvoice(address recipient,uint256 amount,bytes32 nonce)"),
);

/** keccak256(abi.encode(TYPEHASH, recipient, amount, nonce)) */
export function onchainInvoiceHash(recipient: Hex, amount: bigint, nonce: Hex): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, address, uint256, bytes32"), [
      INVOICE_TYPEHASH,
      recipient,
      amount,
      nonce,
    ]),
  );
}

/** keccak256(abi.encodePacked(serial, invoiceHash, uint64 expiry, batchRoot)) */
export function onchainSpendDigest(
  serial: Hex,
  invoiceHash: Hex,
  expiry: number,
  batchRoot: Hex,
): Hex {
  return keccak256(
    encodePacked(
      ["bytes32", "bytes32", "uint64", "bytes32"],
      [serial, invoiceHash, BigInt(expiry), batchRoot],
    ),
  );
}

/** abi.encode(recipient, amount, nonce) — the serial travels as a separate arg. */
export function onchainTranscript(recipient: Hex, amount: bigint, nonce: Hex): Hex {
  return encodeAbiParameters(parseAbiParameters("address, uint256, bytes32"), [
    recipient,
    amount,
    nonce,
  ]);
}

const solLeaf = (serial: Hex): Hex => keccak256(encodePacked(["bytes32"], [serial]));
const solPair = (a: Hex, b: Hex): Hex =>
  BigInt(a) < BigInt(b)
    ? keccak256(encodePacked(["bytes32", "bytes32"], [a, b]))
    : keccak256(encodePacked(["bytes32", "bytes32"], [b, a]));

/**
 * Solidity-side batch root + membership proof over an ordered serial list
 * (leaf = keccak256(serial); OZ MerkleProof-compatible sorted-pair interiors).
 * This is what the vault carves and reconcile verifies — distinct from the
 * TS-side root which folds (serial‖value) leaves.
 */
export function solRootAndProof(
  serials: Hex[],
  index: number,
): { root: Hex; proof: Hex[] } {
  let level = serials.map(solLeaf);
  const proof: Hex[] = [];
  let idx = index;
  while (level.length > 1) {
    const sibling = idx ^ 1;
    if (sibling < level.length) proof.push(level[sibling]!);
    const next: Hex[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push(solPair(level[i]!, level[i + 1]!));
    if (level.length % 2 === 1) next.push(level[level.length - 1]!);
    level = next;
    idx >>= 1;
  }
  return { root: level[0]!, proof };
}

/** Carver raw-digest signature in the on-chain 65-byte {r,s,v} format. */
export async function carverSig65(privateKey: Hex, digest: Hex): Promise<Hex> {
  return signatureToHex(await sign({ hash: digest, privateKey, to: "object" }));
}
