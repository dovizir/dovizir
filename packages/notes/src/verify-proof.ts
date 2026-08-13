/** Merkle helper shared by verifyTranscript and ReconcileTracker. */
import { fromHex } from "./bytes.js";
import { leafOf, verifyProof } from "./merkle.js";
import type { Hex } from "./types.js";

export function buildLeafAndVerify(
  serial: Hex,
  value: bigint,
  proof: readonly Hex[],
  root: Hex,
): boolean {
  return verifyProof(
    leafOf(serial, value),
    proof.map((p) => fromHex(p)),
    fromHex(root),
  );
}
