/**
 * SQLite persistence for the fiat-ramp product layer (docs/design/fiat-ramp.md
 * §2/§3): indicative board rates, RFQs, firm quotes, on/off-ramp orders, and
 * receipt evidence blobs. Kept separate from db.ts (the M1 on-chain event log)
 * — this table set is the OFF-CHAIN order + evidence store.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { OrderStatus, RampDirection } from "./ramp.js";

export function initRampSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS indicative_rates (
      sarraf         TEXT NOT NULL,
      fiat           TEXT NOT NULL,
      buy_rate       TEXT NOT NULL,
      sell_rate      TEXT NOT NULL,
      min_usdt       TEXT NOT NULL,
      max_usdt       TEXT NOT NULL,
      effective_from INTEGER NOT NULL,
      nonce          INTEGER NOT NULL,
      signature      TEXT NOT NULL,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (sarraf, fiat)
    );
    CREATE TABLE IF NOT EXISTS rfqs (
      id          TEXT PRIMARY KEY,
      sarraf      TEXT NOT NULL,
      customer    TEXT NOT NULL,
      direction   TEXT NOT NULL,
      fiat        TEXT NOT NULL,
      usdt_amount TEXT,
      fiat_amount TEXT,
      status      TEXT NOT NULL,
      quote_id    TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rfqs_by_sarraf ON rfqs (sarraf, status);
    CREATE TABLE IF NOT EXISTS firm_quotes (
      quote_id    TEXT PRIMARY KEY,
      rfq_id      TEXT NOT NULL,
      sarraf      TEXT NOT NULL,
      customer    TEXT NOT NULL,
      direction   TEXT NOT NULL,
      fiat        TEXT NOT NULL,
      usdt_amount TEXT NOT NULL,
      fiat_amount TEXT NOT NULL,
      valid_until INTEGER NOT NULL,
      nonce       INTEGER NOT NULL,
      signature   TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ramp_orders (
      id            TEXT PRIMARY KEY,
      quote_id      TEXT NOT NULL,
      sarraf        TEXT NOT NULL,
      customer      TEXT NOT NULL,
      direction     TEXT NOT NULL,
      fiat          TEXT NOT NULL,
      usdt_amount   TEXT NOT NULL,
      fiat_amount   TEXT NOT NULL,
      status        TEXT NOT NULL,
      receipt_id    TEXT,
      issue_tx      TEXT,
      redeem_tx     TEXT,
      sarraf_bank   TEXT,
      customer_bank TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_by_sarraf ON ramp_orders (sarraf, status);
    CREATE INDEX IF NOT EXISTS orders_by_customer ON ramp_orders (customer, status);
    CREATE TABLE IF NOT EXISTS receipts (
      id         TEXT PRIMARY KEY,
      order_id   TEXT NOT NULL,
      uploader   TEXT NOT NULL,
      mime       TEXT NOT NULL,
      hash       TEXT NOT NULL,
      blob       BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

// ------------------------------------------------------------- indicative rates

export interface IndicativeRateRecord {
  sarraf: string;
  fiat: string;
  buyRate: string;
  sellRate: string;
  minUsdt: string;
  maxUsdt: string;
  effectiveFrom: number;
  nonce: number;
  signature: string;
  updatedAt: number;
}

/** Upsert the CURRENT indicative record for (sarraf, fiat) — valid until superseded. */
export function upsertIndicativeRate(db: DB, r: IndicativeRateRecord): void {
  db.prepare(
    `INSERT INTO indicative_rates
       (sarraf, fiat, buy_rate, sell_rate, min_usdt, max_usdt, effective_from, nonce, signature, updated_at)
     VALUES (@sarraf, @fiat, @buyRate, @sellRate, @minUsdt, @maxUsdt, @effectiveFrom, @nonce, @signature, @updatedAt)
     ON CONFLICT(sarraf, fiat) DO UPDATE SET
       buy_rate=excluded.buy_rate, sell_rate=excluded.sell_rate,
       min_usdt=excluded.min_usdt, max_usdt=excluded.max_usdt,
       effective_from=excluded.effective_from, nonce=excluded.nonce,
       signature=excluded.signature, updated_at=excluded.updated_at`,
  ).run(r);
}

function rowToRate(x: Record<string, unknown>): IndicativeRateRecord {
  return {
    sarraf: x.sarraf as string,
    fiat: x.fiat as string,
    buyRate: x.buy_rate as string,
    sellRate: x.sell_rate as string,
    minUsdt: x.min_usdt as string,
    maxUsdt: x.max_usdt as string,
    effectiveFrom: x.effective_from as number,
    nonce: x.nonce as number,
    signature: x.signature as string,
    updatedAt: x.updated_at as number,
  };
}

export function getIndicativeRate(
  db: DB,
  sarraf: string,
  fiat: string,
): IndicativeRateRecord | undefined {
  const row = db
    .prepare("SELECT * FROM indicative_rates WHERE sarraf = ? AND fiat = ?")
    .get(sarraf.toLowerCase(), fiat) as Record<string, unknown> | undefined;
  return row ? rowToRate(row) : undefined;
}

export function listIndicativeRates(db: DB, fiat?: string): IndicativeRateRecord[] {
  const rows = (
    fiat
      ? db.prepare("SELECT * FROM indicative_rates WHERE fiat = ? ORDER BY updated_at DESC").all(fiat)
      : db.prepare("SELECT * FROM indicative_rates ORDER BY fiat ASC, updated_at DESC").all()
  ) as Record<string, unknown>[];
  return rows.map(rowToRate);
}

// -------------------------------------------------------------------- RFQ

export interface RfqRecord {
  id: string;
  sarraf: string;
  customer: string;
  direction: RampDirection;
  fiat: string;
  usdtAmount?: string;
  fiatAmount?: string;
  status: "pending" | "quoted";
  quoteId?: string;
  createdAt: number;
}

export function insertRfq(
  db: DB,
  r: Omit<RfqRecord, "id" | "status" | "quoteId" | "createdAt">,
  now: number,
): RfqRecord {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO rfqs (id, sarraf, customer, direction, fiat, usdt_amount, fiat_amount, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    r.sarraf.toLowerCase(),
    r.customer.toLowerCase(),
    r.direction,
    r.fiat,
    r.usdtAmount ?? null,
    r.fiatAmount ?? null,
    now,
  );
  return getRfq(db, id)!;
}

function rowToRfq(x: Record<string, unknown>): RfqRecord {
  return {
    id: x.id as string,
    sarraf: x.sarraf as string,
    customer: x.customer as string,
    direction: x.direction as RampDirection,
    fiat: x.fiat as string,
    usdtAmount: (x.usdt_amount as string) ?? undefined,
    fiatAmount: (x.fiat_amount as string) ?? undefined,
    status: x.status as RfqRecord["status"],
    quoteId: (x.quote_id as string) ?? undefined,
    createdAt: x.created_at as number,
  };
}

export function getRfq(db: DB, id: string): RfqRecord | undefined {
  const row = db.prepare("SELECT * FROM rfqs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRfq(row) : undefined;
}

export function listRfqs(db: DB, filter: { sarraf?: string; customer?: string }): RfqRecord[] {
  let sql = "SELECT * FROM rfqs";
  const clauses: string[] = [];
  const args: string[] = [];
  if (filter.sarraf) {
    clauses.push("sarraf = ?");
    args.push(filter.sarraf.toLowerCase());
  }
  if (filter.customer) {
    clauses.push("customer = ?");
    args.push(filter.customer.toLowerCase());
  }
  if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
  sql += " ORDER BY created_at DESC";
  return (db.prepare(sql).all(...args) as Record<string, unknown>[]).map(rowToRfq);
}

export function markRfqQuoted(db: DB, id: string, quoteId: string): void {
  db.prepare("UPDATE rfqs SET status = 'quoted', quote_id = ? WHERE id = ?").run(quoteId, id);
}

// ------------------------------------------------------------- firm quotes

export interface FirmQuoteRecord {
  quoteId: string;
  rfqId: string;
  sarraf: string;
  customer: string;
  direction: RampDirection;
  fiat: string;
  usdtAmount: string;
  fiatAmount: string;
  validUntil: number;
  nonce: number;
  signature: string;
  createdAt: number;
}

export function insertFirmQuote(db: DB, q: FirmQuoteRecord): void {
  db.prepare(
    `INSERT INTO firm_quotes
       (quote_id, rfq_id, sarraf, customer, direction, fiat, usdt_amount, fiat_amount, valid_until, nonce, signature, created_at)
     VALUES (@quoteId, @rfqId, @sarraf, @customer, @direction, @fiat, @usdtAmount, @fiatAmount, @validUntil, @nonce, @signature, @createdAt)`,
  ).run({ ...q, sarraf: q.sarraf.toLowerCase(), customer: q.customer.toLowerCase() });
}

function rowToQuote(x: Record<string, unknown>): FirmQuoteRecord {
  return {
    quoteId: x.quote_id as string,
    rfqId: x.rfq_id as string,
    sarraf: x.sarraf as string,
    customer: x.customer as string,
    direction: x.direction as RampDirection,
    fiat: x.fiat as string,
    usdtAmount: x.usdt_amount as string,
    fiatAmount: x.fiat_amount as string,
    validUntil: x.valid_until as number,
    nonce: x.nonce as number,
    signature: x.signature as string,
    createdAt: x.created_at as number,
  };
}

export function getFirmQuote(db: DB, quoteId: string): FirmQuoteRecord | undefined {
  const row = db.prepare("SELECT * FROM firm_quotes WHERE quote_id = ?").get(quoteId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToQuote(row) : undefined;
}

// ----------------------------------------------------------------- orders

export interface OrderRecord {
  id: string;
  quoteId: string;
  sarraf: string;
  customer: string;
  direction: RampDirection;
  fiat: string;
  usdtAmount: string;
  fiatAmount: string;
  status: OrderStatus;
  receiptId?: string;
  issueTx?: string;
  redeemTx?: string;
  sarrafBank?: string;
  customerBank?: string;
  createdAt: number;
  updatedAt: number;
}

export function insertOrder(
  db: DB,
  o: Omit<OrderRecord, "receiptId" | "issueTx" | "redeemTx">,
): void {
  db.prepare(
    `INSERT INTO ramp_orders
       (id, quote_id, sarraf, customer, direction, fiat, usdt_amount, fiat_amount, status, sarraf_bank, customer_bank, created_at, updated_at)
     VALUES (@id, @quoteId, @sarraf, @customer, @direction, @fiat, @usdtAmount, @fiatAmount, @status, @sarrafBank, @customerBank, @createdAt, @updatedAt)`,
  ).run({
    ...o,
    sarraf: o.sarraf.toLowerCase(),
    customer: o.customer.toLowerCase(),
    sarrafBank: o.sarrafBank ?? null,
    customerBank: o.customerBank ?? null,
  });
}

function rowToOrder(x: Record<string, unknown>): OrderRecord {
  return {
    id: x.id as string,
    quoteId: x.quote_id as string,
    sarraf: x.sarraf as string,
    customer: x.customer as string,
    direction: x.direction as RampDirection,
    fiat: x.fiat as string,
    usdtAmount: x.usdt_amount as string,
    fiatAmount: x.fiat_amount as string,
    status: x.status as OrderStatus,
    receiptId: (x.receipt_id as string) ?? undefined,
    issueTx: (x.issue_tx as string) ?? undefined,
    redeemTx: (x.redeem_tx as string) ?? undefined,
    sarrafBank: (x.sarraf_bank as string) ?? undefined,
    customerBank: (x.customer_bank as string) ?? undefined,
    createdAt: x.created_at as number,
    updatedAt: x.updated_at as number,
  };
}

export function getOrder(db: DB, id: string): OrderRecord | undefined {
  const row = db.prepare("SELECT * FROM ramp_orders WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToOrder(row) : undefined;
}

export function listOrders(
  db: DB,
  filter: { sarraf?: string; customer?: string; status?: OrderStatus },
): OrderRecord[] {
  let sql = "SELECT * FROM ramp_orders";
  const clauses: string[] = [];
  const args: string[] = [];
  if (filter.sarraf) {
    clauses.push("sarraf = ?");
    args.push(filter.sarraf.toLowerCase());
  }
  if (filter.customer) {
    clauses.push("customer = ?");
    args.push(filter.customer.toLowerCase());
  }
  if (filter.status) {
    clauses.push("status = ?");
    args.push(filter.status);
  }
  if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
  sql += " ORDER BY created_at DESC";
  return (db.prepare(sql).all(...args) as Record<string, unknown>[]).map(rowToOrder);
}

/** Patch mutable order columns (status/receipt/tx/bank), stamping updated_at. */
export function updateOrder(
  db: DB,
  id: string,
  patch: Partial<
    Pick<
      OrderRecord,
      "status" | "receiptId" | "issueTx" | "redeemTx" | "sarrafBank" | "customerBank"
    >
  >,
  now: number,
): OrderRecord | undefined {
  const columns: Record<keyof typeof patch, string> = {
    status: "status",
    receiptId: "receipt_id",
    issueTx: "issue_tx",
    redeemTx: "redeem_tx",
    sarrafBank: "sarraf_bank",
    customerBank: "customer_bank",
  };
  const sets: string[] = [];
  const args: (string | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${columns[k as keyof typeof patch]} = ?`);
    args.push((v as string | undefined) ?? null);
  }
  sets.push("updated_at = ?");
  db.prepare(`UPDATE ramp_orders SET ${sets.join(", ")} WHERE id = ?`).run(...args, now, id);
  return getOrder(db, id);
}

/**
 * Find the open on-ramp order an Issued(sarraf, to, amount) event settles.
 * Matches a FIAT_CLAIMED order awaiting the Sarraf's on-chain issuance.
 */
export function findClaimedOnRampOrder(
  db: DB,
  sarraf: string,
  customer: string,
  usdtAmount: string,
): OrderRecord | undefined {
  const row = db
    .prepare(
      `SELECT * FROM ramp_orders
       WHERE direction = 'on-ramp' AND status = 'FIAT_CLAIMED'
         AND sarraf = ? AND customer = ? AND usdt_amount = ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(sarraf.toLowerCase(), customer.toLowerCase(), usdtAmount) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToOrder(row) : undefined;
}

// ---------------------------------------------------------------- receipts

export interface ReceiptMeta {
  id: string;
  orderId: string;
  uploader: string;
  mime: string;
  hash: string;
  createdAt: number;
}

export function insertReceipt(
  db: DB,
  r: { orderId: string; uploader: string; mime: string; hash: string; blob: Buffer },
  now: number,
): ReceiptMeta {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO receipts (id, order_id, uploader, mime, hash, blob, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, r.orderId, r.uploader.toLowerCase(), r.mime, r.hash, r.blob, now);
  return { id, orderId: r.orderId, uploader: r.uploader.toLowerCase(), mime: r.mime, hash: r.hash, createdAt: now };
}

export function getReceiptMeta(db: DB, id: string): ReceiptMeta | undefined {
  const row = db
    .prepare("SELECT id, order_id, uploader, mime, hash, created_at FROM receipts WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    orderId: row.order_id as string,
    uploader: row.uploader as string,
    mime: row.mime as string,
    hash: row.hash as string,
    createdAt: row.created_at as number,
  };
}

export function getReceiptBlob(db: DB, id: string): { mime: string; blob: Buffer } | undefined {
  const row = db.prepare("SELECT mime, blob FROM receipts WHERE id = ?").get(id) as
    | { mime: string; blob: Buffer }
    | undefined;
  return row ? { mime: row.mime, blob: row.blob } : undefined;
}
