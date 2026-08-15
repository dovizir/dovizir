/**
 * P2P escrow read-model derivations (docs/design/fiat-ramp.md §4). PURE — no IO,
 * no DB — so it is unit-testable with synthetic data and reused by the sync hook
 * and REST layer.
 *
 * Unlike the direct ramp (§3), the P2P order's authoritative state lives ON-CHAIN
 * in Escrow.sol: the indexer mirrors it by mapping each escrow event to a status,
 * and keeps only the off-chain evidence (receipt blob, chat notes, bank details)
 * that never touches the chain.
 */

export type Hex = `0x${string}`;

/** Mirrors Escrow.sol's Status enum names (the on-chain source of truth). */
export type P2pStatus =
  | "OPEN"
  | "MATCHED"
  | "FIAT_CLAIMED"
  | "SETTLED"
  | "REFUNDED"
  | "DISPUTED"
  | "RESOLVED_TAKER"
  | "RESOLVED_MAKER";

export const P2P_TERMINAL: ReadonlySet<P2pStatus> = new Set([
  "SETTLED",
  "REFUNDED",
  "RESOLVED_TAKER",
  "RESOLVED_MAKER",
]);

export const P2P_LOCKED: ReadonlySet<P2pStatus> = new Set([
  "OPEN",
  "MATCHED",
  "FIAT_CLAIMED",
  "DISPUTED",
]);

/** True once the IOU has been released out of escrow (a terminal state). */
export function isSettled(status: P2pStatus): boolean {
  return P2P_TERMINAL.has(status);
}

/** True while the IOU is still custodied by the escrow for this order. */
export function isLocked(status: P2pStatus): boolean {
  return P2P_LOCKED.has(status);
}

/**
 * Map an escrow event to the status it moves the order into. `DisputeResolved`
 * needs the `toTaker` flag to pick the winner. Returns undefined for events that
 * don't change status (there are none today, but keeps the caller total).
 */
export function statusFromEvent(event: string, toTaker?: boolean): P2pStatus | undefined {
  switch (event) {
    case "OrderCreated":
      return "OPEN";
    case "OrderFilled":
      return "MATCHED";
    case "FiatClaimed":
      return "FIAT_CLAIMED";
    case "OrderSettled":
      return "SETTLED";
    case "OrderRefunded":
      return "REFUNDED";
    case "DisputeRaised":
      return "DISPUTED";
    case "DisputeResolved":
      return toTaker ? "RESOLVED_TAKER" : "RESOLVED_MAKER";
    default:
      return undefined;
  }
}

/**
 * The arbiter is DERIVED from the tranche id exactly as Escrow.sol derives it:
 * `arbiter = address(uint160(trancheId))`. This is the same unspoofable binding
 * the contract enforces, recomputed off-chain so the UI can label the arbiter
 * without trusting any event field.
 */
export function arbiterFromTrancheId(trancheId: string | bigint): Hex {
  const id = typeof trancheId === "bigint" ? trancheId : BigInt(trancheId);
  const masked = id & ((1n << 160n) - 1n); // low 160 bits
  const hex = masked.toString(16).padStart(40, "0");
  return `0x${hex}` as Hex;
}

/** Only the two counterparties (or the arbiter) may see private order evidence. */
export function isParty(
  order: { maker: string; taker?: string; arbiter: string },
  who: string,
): boolean {
  const w = who.toLowerCase();
  return (
    w === order.maker.toLowerCase() ||
    (!!order.taker && w === order.taker.toLowerCase()) ||
    w === order.arbiter.toLowerCase()
  );
}
