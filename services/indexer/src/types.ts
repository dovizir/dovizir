/** Canonical shape of a persisted event row, decoded into plain JSON scalars. */
export interface IndexedEvent {
  contract: ContractName;
  event: string;
  blockNumber: number;
  /** Unix seconds of the containing block (0 if not yet resolved). */
  blockTime: number;
  logIndex: number;
  txHash: string;
  /** Event args with bigints stringified and addresses lowercased. */
  args: Record<string, string>;
}

export type ContractName =
  | "iouToken"
  | "reservePool"
  | "insuranceFund"
  | "sarrafRegistry"
  | "memberRegistry"
  | "noteVault"
  | "escrow";

/** A backing-change checkpoint used by the TWAB integral. */
export interface Checkpoint {
  timestamp: number;
  balance: bigint;
}

export type SerialStatus = "pending" | "spent" | "unknown";

export interface PendingSerial {
  serial: string;
  payload: string;
  status: Exclude<SerialStatus, "unknown">;
  createdAt: number;
  reconciledTx?: string;
  reconciledAmount?: string;
  recipient?: string;
  /** "reconciled" | "convicted" once settled on-chain. */
  outcome?: "reconciled" | "convicted";
}
