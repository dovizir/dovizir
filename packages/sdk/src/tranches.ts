import type { Hex } from "./addresses";

/**
 * IDovizir.sol: one fungible ERC-1155 id per sarraf,
 * `trancheId = uint256(uint160(sarraf))`.
 */
export function trancheId(sarraf: Hex): bigint {
  return BigInt(sarraf);
}

/** Inverse mapping: tranche id -> issuing sarraf address. */
export function sarrafOfTranche(id: bigint): Hex {
  return `0x${id.toString(16).padStart(40, "0")}` as Hex;
}
