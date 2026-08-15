/**
 * Event-sync loop: getLogs from the deployed M1 contracts, decode with the SDK
 * ABIs, and persist idempotently. Tracks a block cursor; on every poll it
 * re-scans the last `reorgDepth` blocks (delete-then-reinsert) so a shallow
 * reorg self-heals without a full resync.
 */
import type { AbiEvent } from "viem";
import {
  iouTokenAbi,
  reservePoolAbi,
  insuranceFundAbi,
  sarrafRegistryAbi,
  memberRegistryAbi,
  noteVaultAbi,
} from "@dovizir/sdk";
import type { IndexerConfig } from "./config.js";
import { makeClient } from "./config.js";
import {
  type DB,
  deleteEventsFrom,
  getLastBlock,
  markSerialSettled,
  setLastBlock,
  upsertEvents,
} from "./db.js";
import type { ContractName, IndexedEvent } from "./types.js";
import { applyOrderEvent } from "./ramp.js";
import { findClaimedOnRampOrder, updateOrder } from "./ramp-store.js";

interface Source {
  name: ContractName;
  address: `0x${string}`;
  events: AbiEvent[];
}

const eventsOf = (abi: readonly unknown[]): AbiEvent[] =>
  abi.filter((x): x is AbiEvent => (x as { type?: string }).type === "event");

export function buildSources(cfg: IndexerConfig): Source[] {
  const specs: Array<[ContractName, `0x${string}`, readonly unknown[]]> = [
    ["iouToken", cfg.addresses.iouToken, iouTokenAbi],
    ["reservePool", cfg.addresses.reservePool, reservePoolAbi],
    ["insuranceFund", cfg.addresses.insuranceFund, insuranceFundAbi],
    ["sarrafRegistry", cfg.addresses.sarrafRegistry, sarrafRegistryAbi],
    ["memberRegistry", cfg.addresses.memberRegistry, memberRegistryAbi],
    ["noteVault", cfg.addresses.noteVault, noteVaultAbi],
  ];
  const ZERO = "0x0000000000000000000000000000000000000000";
  return specs
    .filter(([, addr]) => addr !== ZERO)
    .map(([name, address, abi]) => ({ name, address, events: eventsOf(abi) }));
}

/** Serialize decoded args to JSON scalars (bigint→string, hex lowercased). */
function serializeArgs(args: Record<string, unknown> | readonly unknown[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!args || Array.isArray(args)) return out;
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else if (typeof v === "string") out[k] = v.startsWith("0x") ? v.toLowerCase() : v;
    else if (Array.isArray(v)) out[k] = JSON.stringify(v.map((x) => (typeof x === "bigint" ? x.toString() : x)));
    else if (v === undefined || v === null) out[k] = "";
    else out[k] = String(v);
  }
  return out;
}

export interface SyncDeps {
  db: DB;
  cfg: IndexerConfig;
  client: ReturnType<typeof makeClient>;
  sources: Source[];
  log?: (msg: string) => void;
}

/** One sync pass from `fromBlock` to the chain head. Returns the new cursor. */
export async function syncOnce(deps: SyncDeps): Promise<bigint> {
  const { db, cfg, client, sources } = deps;
  const head = await client.getBlockNumber();
  let from = getLastBlock(db, cfg.startBlock);

  // Reorg safety: rewind the cursor and drop the tail before re-scanning.
  if (from > cfg.reorgDepth) {
    from -= cfg.reorgDepth;
    deleteEventsFrom(db, from);
  } else {
    from = cfg.startBlock;
    deleteEventsFrom(db, from);
  }

  const blockTimeCache = new Map<bigint, number>();
  const resolveTime = async (bn: bigint): Promise<number> => {
    const cached = blockTimeCache.get(bn);
    if (cached !== undefined) return cached;
    const block = await client.getBlock({ blockNumber: bn });
    const t = Number(block.timestamp);
    blockTimeCache.set(bn, t);
    return t;
  };

  for (let start = from; start <= head; start += cfg.pageSize + 1n) {
    const end = start + cfg.pageSize > head ? head : start + cfg.pageSize;
    const batch: IndexedEvent[] = [];
    for (const src of sources) {
      const logs = await client.getLogs({
        address: src.address,
        events: src.events,
        fromBlock: start,
        toBlock: end,
      });
      for (const l of logs) {
        if (l.blockNumber == null || l.logIndex == null) continue;
        batch.push({
          contract: src.name,
          event: (l as { eventName?: string }).eventName ?? "Unknown",
          blockNumber: Number(l.blockNumber),
          blockTime: await resolveTime(l.blockNumber),
          logIndex: l.logIndex,
          txHash: l.transactionHash ?? "",
          args: serializeArgs((l as { args?: Record<string, unknown> }).args),
        });
      }
    }
    if (batch.length) {
      upsertEvents(db, batch);
      reconcileSerials(db, batch);
      settleOnRampOrders(db, batch);
    }
  }

  setLastBlock(db, head);
  return head;
}

/**
 * When a NoteReconciled / DoubleSpendConvicted lands on-chain, flip any matching
 * pending serial in the offline-notes feed to "spent".
 */
function reconcileSerials(db: DB, batch: IndexedEvent[]): void {
  for (const e of batch) {
    if (e.contract !== "noteVault") continue;
    if (e.event === "NoteReconciled") {
      markSerialSettled(db, e.args.serial, "reconciled", e.txHash, e.args.amount, e.args.recipient);
    } else if (e.event === "DoubleSpendConvicted") {
      markSerialSettled(db, e.args.serial, "convicted", e.txHash, undefined, e.args.victim);
    }
  }
}

/**
 * Link the on-chain Issued(sarraf, to, amount) event to the off-chain on-ramp
 * order it closes: a FIAT_CLAIMED order whose Sarraf just issued IOU to the
 * customer for the agreed amount advances to SETTLED (fiat-ramp.md §3). The
 * Sarraf's desk "confirm" also settles it; whichever lands first wins and the
 * other is a no-op (guarded on the FIAT_CLAIMED status inside the finder).
 */
function settleOnRampOrders(db: DB, batch: IndexedEvent[]): void {
  const now = Math.floor(Date.now() / 1000);
  for (const e of batch) {
    if (e.contract !== "reservePool" || e.event !== "Issued") continue;
    const order = findClaimedOnRampOrder(db, e.args.sarraf, e.args.to, e.args.amount);
    if (!order) continue;
    const next = applyOrderEvent(order.direction, order.status, "ISSUE_CONFIRMED");
    updateOrder(db, order.id, { status: next, issueTx: e.txHash }, now);
  }
}

/** Poll forever, sleeping `pollIntervalMs` between passes. */
export async function runSyncLoop(deps: SyncDeps, signal?: { stopped: boolean }): Promise<void> {
  for (;;) {
    if (signal?.stopped) return;
    try {
      const head = await syncOnce(deps);
      deps.log?.(`synced to block ${head}`);
    } catch (err) {
      deps.log?.(`sync error: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, deps.cfg.pollIntervalMs));
  }
}
