/**
 * Merkle commitments over note batches (frozen pin #4):
 *  - leaf = keccak256(serial ‖ uint256-be(value));
 *  - serial = keccak256(batchSalt ‖ uint32-be(index));
 *  - interior nodes: commutative sorted-pair keccak-256 (OpenZeppelin
 *    MerkleProof compatible);
 *  - single-leaf batch: root == leaf, empty proof;
 *  - odd trailing node promoted unchanged (unpinned; matches the EVM-side
 *    TranscriptLib so tooling can share batches).
 */
import { concatBytes, fromHex, keccak_256, u256be } from "./bytes.js";

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/** Commutative sorted-pair keccak. */
export function pairHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  return cmpBytes(a, b) <= 0 ? keccak_256(concatBytes(a, b)) : keccak_256(concatBytes(b, a));
}

export function leafOf(serial: string, value: bigint): Uint8Array {
  return keccak_256(concatBytes(fromHex(serial), u256be(value)));
}

/** Root + per-leaf proofs in one pass. */
export function buildMerkle(leaves: Uint8Array[]): { root: Uint8Array; proofs: Uint8Array[][] } {
  if (leaves.length === 0) throw new Error("buildMerkle: empty batch");
  const proofs: Uint8Array[][] = leaves.map(() => []);
  const positions = leaves.map((_, i) => i);
  let level = leaves.slice();
  while (level.length > 1) {
    for (let li = 0; li < proofs.length; li++) {
      const sibling = positions[li]! ^ 1;
      if (sibling < level.length) proofs[li]!.push(level[sibling]!);
      positions[li] = positions[li]! >> 1;
    }
    const next: Uint8Array[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push(pairHash(level[i]!, level[i + 1]!));
    if (level.length % 2 === 1) next.push(level[level.length - 1]!); // odd node promoted
    level = next;
  }
  return { root: level[0]!, proofs };
}

/** Fold a proof from a leaf; true iff it lands on `root`. */
export function verifyProof(leaf: Uint8Array, proof: readonly Uint8Array[], root: Uint8Array): boolean {
  let node = leaf;
  for (const sibling of proof) node = pairHash(node, sibling);
  return cmpBytes(node, root) === 0;
}
