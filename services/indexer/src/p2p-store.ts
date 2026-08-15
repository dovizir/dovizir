/**
 * SQLite persistence for the P2P escrow order book (docs/design/fiat-ramp.md §4).
 *
 * The order's authoritative state is on-chain (Escrow.sol); this table is a
 * MIRROR built from escrow events (see applyEscrowEvent in sync.ts), plus the
 * off-chain evidence the chain never holds: the fiat receipt (reusing the shared
 * `receipts` table from ramp-store.ts), a per-order chat/notes thread (US#5), and
 * the counterparties' bank-detail exchange.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { P2pStatus } from "./p2p.js";

export function initP2pSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS p2p_orders (
      order_id       TEXT PRIMARY KEY,       -- on-chain uint order id (as string)
      maker          TEXT NOT NULL,
      taker          TEXT,
      arbiter        TEXT NOT NULL,          -- derived from tranche id
      tranche_id     TEXT NOT NULL,
      usdt_amount    TEXT NOT NULL,
      fiat           TEXT NOT NULL,
      fiat_amount    TEXT NOT NULL,
      quote_hash     TEXT NOT NULL,
      receipt_hash   TEXT,                   -- on-chain hash set at FIAT_CLAIMED
      payment_window INTEGER NOT NULL,
      payment_deadline INTEGER,
      confirm_deadline INTEGER,
      status         TEXT NOT NULL,
      dispute_by     TEXT,                   -- who raised the dispute
      resolved_to    TEXT,                   -- 'taker' | 'maker' once resolved
      receipt_id     TEXT,                   -- off-chain evidence blob id
      maker_bank     TEXT,
      taker_bank     TEXT,
      created_block  INTEGER,
      settle_tx      TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS p2p_by_maker   ON p2p_orders (maker, status);
    CREATE INDEX IF NOT EXISTS p2p_by_taker   ON p2p_orders (taker, status);
    CREATE INDEX IF NOT EXISTS p2p_by_arbiter ON p2p_orders (arbiter, status);
    CREATE INDEX IF NOT EXISTS p2p_by_status  ON p2p_orders (status);
    CREATE TABLE IF NOT EXISTS p2p_notes (
      id         TEXT PRIMARY KEY,
      order_id   TEXT NOT NULL,
      author     TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS p2p_notes_by_order ON p2p_notes (order_id, created_at);
  `);
}

export interface P2pOrderRecord {
  orderId: string;
  maker: string;
  taker?: string;
  arbiter: string;
  trancheId: string;
  usdtAmount: string;
  fiat: string;
  fiatAmount: string;
  quoteHash: string;
  receiptHash?: string;
  paymentWindow: number;
  paymentDeadline?: number;
  confirmDeadline?: number;
  status: P2pStatus;
  disputeBy?: string;
  resolvedTo?: "taker" | "maker";
  receiptId?: string;
  makerBank?: string;
  takerBank?: string;
  createdBlock?: number;
  settleTx?: string;
  createdAt: number;
  updatedAt: number;
}

function rowToOrder(x: Record<string, unknown>): P2pOrderRecord {
  return {
    orderId: x.order_id as string,
    maker: x.maker as string,
    taker: (x.taker as string) ?? undefined,
    arbiter: x.arbiter as string,
    trancheId: x.tranche_id as string,
    usdtAmount: x.usdt_amount as string,
    fiat: x.fiat as string,
    fiatAmount: x.fiat_amount as string,
    quoteHash: x.quote_hash as string,
    receiptHash: (x.receipt_hash as string) ?? undefined,
    paymentWindow: x.payment_window as number,
    paymentDeadline: (x.payment_deadline as number) ?? undefined,
    confirmDeadline: (x.confirm_deadline as number) ?? undefined,
    status: x.status as P2pStatus,
    disputeBy: (x.dispute_by as string) ?? undefined,
    resolvedTo: (x.resolved_to as "taker" | "maker") ?? undefined,
    receiptId: (x.receipt_id as string) ?? undefined,
    makerBank: (x.maker_bank as string) ?? undefined,
    takerBank: (x.taker_bank as string) ?? undefined,
    createdBlock: (x.created_block as number) ?? undefined,
    settleTx: (x.settle_tx as string) ?? undefined,
    createdAt: x.created_at as number,
    updatedAt: x.updated_at as number,
  };
}

/** Insert the mirror row when OrderCreated is first seen (idempotent). */
export function upsertCreatedOrder(
  db: DB,
  o: {
    orderId: string;
    maker: string;
    arbiter: string;
    trancheId: string;
    usdtAmount: string;
    fiat: string;
    fiatAmount: string;
    quoteHash: string;
    paymentWindow: number;
    createdBlock?: number;
  },
  now: number,
): void {
  db.prepare(
    `INSERT INTO p2p_orders
       (order_id, maker, arbiter, tranche_id, usdt_amount, fiat, fiat_amount, quote_hash,
        payment_window, status, created_block, created_at, updated_at)
     VALUES (@orderId, @maker, @arbiter, @trancheId, @usdtAmount, @fiat, @fiatAmount, @quoteHash,
        @paymentWindow, 'OPEN', @createdBlock, @now, @now)
     ON CONFLICT(order_id) DO NOTHING`,
  ).run({
    orderId: o.orderId,
    maker: o.maker.toLowerCase(),
    arbiter: o.arbiter.toLowerCase(),
    trancheId: o.trancheId,
    usdtAmount: o.usdtAmount,
    fiat: o.fiat,
    fiatAmount: o.fiatAmount,
    quoteHash: o.quoteHash,
    paymentWindow: o.paymentWindow,
    createdBlock: o.createdBlock ?? null,
    now,
  });
}

const CHAIN_COLUMNS: Record<string, string> = {
  status: "status",
  taker: "taker",
  receiptHash: "receipt_hash",
  paymentDeadline: "payment_deadline",
  confirmDeadline: "confirm_deadline",
  disputeBy: "dispute_by",
  resolvedTo: "resolved_to",
  settleTx: "settle_tx",
};

/** Patch on-chain-derived columns from a later escrow event. */
export function patchOrderFromChain(
  db: DB,
  orderId: string,
  patch: Partial<
    Pick<
      P2pOrderRecord,
      "status" | "taker" | "receiptHash" | "paymentDeadline" | "confirmDeadline" | "disputeBy" | "resolvedTo" | "settleTx"
    >
  >,
  now: number,
): void {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = CHAIN_COLUMNS[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    args.push(typeof v === "string" && v.startsWith("0x") ? v.toLowerCase() : (v as string | number | null) ?? null);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  db.prepare(`UPDATE p2p_orders SET ${sets.join(", ")} WHERE order_id = ?`).run(...args, now, orderId);
}

const OFFCHAIN_COLUMNS: Record<string, string> = {
  receiptId: "receipt_id",
  makerBank: "maker_bank",
  takerBank: "taker_bank",
};

/** Patch off-chain columns (evidence / bank details) set via REST. */
export function patchOrderOffchain(
  db: DB,
  orderId: string,
  patch: Partial<Pick<P2pOrderRecord, "receiptId" | "makerBank" | "takerBank">>,
  now: number,
): P2pOrderRecord | undefined {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = OFFCHAIN_COLUMNS[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    args.push((v as string | undefined) ?? null);
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    db.prepare(`UPDATE p2p_orders SET ${sets.join(", ")} WHERE order_id = ?`).run(...args, now, orderId);
  }
  return getP2pOrder(db, orderId);
}

export function getP2pOrder(db: DB, orderId: string): P2pOrderRecord | undefined {
  const row = db.prepare("SELECT * FROM p2p_orders WHERE order_id = ?").get(orderId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToOrder(row) : undefined;
}

export function listP2pOrders(
  db: DB,
  filter: { maker?: string; taker?: string; arbiter?: string; status?: P2pStatus; fiat?: string; open?: boolean },
): P2pOrderRecord[] {
  let sql = "SELECT * FROM p2p_orders";
  const clauses: string[] = [];
  const args: string[] = [];
  if (filter.maker) {
    clauses.push("maker = ?");
    args.push(filter.maker.toLowerCase());
  }
  if (filter.taker) {
    clauses.push("taker = ?");
    args.push(filter.taker.toLowerCase());
  }
  if (filter.arbiter) {
    clauses.push("arbiter = ?");
    args.push(filter.arbiter.toLowerCase());
  }
  if (filter.status) {
    clauses.push("status = ?");
    args.push(filter.status);
  }
  if (filter.fiat) {
    clauses.push("fiat = ?");
    args.push(filter.fiat);
  }
  if (filter.open) clauses.push("status = 'OPEN'");
  if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
  sql += " ORDER BY created_at DESC";
  return (db.prepare(sql).all(...args) as Record<string, unknown>[]).map(rowToOrder);
}

// ------------------------------------------------------------------ notes (chat)

export interface P2pNote {
  id: string;
  orderId: string;
  author: string;
  body: string;
  createdAt: number;
}

export function insertNote(
  db: DB,
  n: { orderId: string; author: string; body: string },
  now: number,
): P2pNote {
  const id = randomUUID();
  db.prepare("INSERT INTO p2p_notes (id, order_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    n.orderId,
    n.author.toLowerCase(),
    n.body,
    now,
  );
  return { id, orderId: n.orderId, author: n.author.toLowerCase(), body: n.body, createdAt: now };
}

export function listNotes(db: DB, orderId: string): P2pNote[] {
  const rows = db
    .prepare("SELECT * FROM p2p_notes WHERE order_id = ? ORDER BY created_at ASC")
    .all(orderId) as Record<string, unknown>[];
  return rows.map((x) => ({
    id: x.id as string,
    orderId: x.order_id as string,
    author: x.author as string,
    body: x.body as string,
    createdAt: x.created_at as number,
  }));
}
