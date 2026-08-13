/** SQLite persistence: event log, sync cursor, and the pending-serials feed. */
import Database from "better-sqlite3";
import type { IndexedEvent, PendingSerial } from "./types.js";

export type DB = Database.Database;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      tx_hash      TEXT NOT NULL,
      log_index    INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      block_time   INTEGER NOT NULL,
      contract     TEXT NOT NULL,
      event        TEXT NOT NULL,
      args         TEXT NOT NULL,
      PRIMARY KEY (tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS events_by_block ON events (block_number, log_index);
    CREATE INDEX IF NOT EXISTS events_by_kind  ON events (contract, event);
    CREATE TABLE IF NOT EXISTS pending_serials (
      serial            TEXT PRIMARY KEY,
      payload           TEXT NOT NULL,
      status            TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      reconciled_tx     TEXT,
      reconciled_amount TEXT,
      recipient         TEXT,
      outcome           TEXT
    );
  `);
  return db;
}

// ------------------------------------------------------------------ cursor

export function getLastBlock(db: DB, fallback: bigint): bigint {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'lastBlock'").get() as
    | { value: string }
    | undefined;
  return row ? BigInt(row.value) : fallback;
}

export function setLastBlock(db: DB, block: bigint): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('lastBlock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(block.toString());
}

// ------------------------------------------------------------------ events

/** Idempotent upsert of a decoded event (PK = tx_hash+log_index). */
export function upsertEvents(db: DB, events: IndexedEvent[]): void {
  const stmt = db.prepare(
    `INSERT INTO events (tx_hash, log_index, block_number, block_time, contract, event, args)
     VALUES (@txHash, @logIndex, @blockNumber, @blockTime, @contract, @event, @args)
     ON CONFLICT(tx_hash, log_index) DO UPDATE SET
       block_number = excluded.block_number,
       block_time   = excluded.block_time,
       contract     = excluded.contract,
       event        = excluded.event,
       args         = excluded.args`,
  );
  const tx = db.transaction((rows: IndexedEvent[]) => {
    for (const e of rows) {
      stmt.run({
        txHash: e.txHash,
        logIndex: e.logIndex,
        blockNumber: e.blockNumber,
        blockTime: e.blockTime,
        contract: e.contract,
        event: e.event,
        args: JSON.stringify(e.args),
      });
    }
  });
  tx(events);
}

/** Drop events at or above `fromBlock` — the reorg re-scan replaces them. */
export function deleteEventsFrom(db: DB, fromBlock: bigint): void {
  db.prepare("DELETE FROM events WHERE block_number >= ?").run(Number(fromBlock));
}

function rowToEvent(r: {
  contract: string;
  event: string;
  block_number: number;
  block_time: number;
  log_index: number;
  tx_hash: string;
  args: string;
}): IndexedEvent {
  return {
    contract: r.contract as IndexedEvent["contract"],
    event: r.event,
    blockNumber: r.block_number,
    blockTime: r.block_time,
    logIndex: r.log_index,
    txHash: r.tx_hash,
    args: JSON.parse(r.args),
  };
}

/** All events in chain order — the input to every derivation. */
export function allEvents(db: DB): IndexedEvent[] {
  const rows = db
    .prepare(
      "SELECT * FROM events ORDER BY block_number ASC, log_index ASC",
    )
    .all() as Parameters<typeof rowToEvent>[0][];
  return rows.map(rowToEvent);
}

export function eventCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
}

// ------------------------------------------------------------- pending serials

export function insertPendingSerial(
  db: DB,
  serial: string,
  payload: string,
  createdAt: number,
): void {
  db.prepare(
    `INSERT INTO pending_serials (serial, payload, status, created_at)
     VALUES (?, ?, 'pending', ?)
     ON CONFLICT(serial) DO UPDATE SET payload = excluded.payload`,
  ).run(serial, payload, createdAt);
}

export function getPendingSerials(db: DB): PendingSerial[] {
  const rows = db
    .prepare("SELECT * FROM pending_serials WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as SerialRow[];
  return rows.map(rowToSerial);
}

export function getSerial(db: DB, serial: string): PendingSerial | undefined {
  const row = db.prepare("SELECT * FROM pending_serials WHERE serial = ?").get(serial) as
    | SerialRow
    | undefined;
  return row ? rowToSerial(row) : undefined;
}

/** Mark a serial settled from an on-chain NoteReconciled/DoubleSpendConvicted. */
export function markSerialSettled(
  db: DB,
  serial: string,
  outcome: "reconciled" | "convicted",
  tx: string,
  amount?: string,
  recipient?: string,
): void {
  db.prepare(
    `UPDATE pending_serials
       SET status = 'spent', outcome = ?, reconciled_tx = ?, reconciled_amount = ?, recipient = ?
     WHERE serial = ?`,
  ).run(outcome, tx, amount ?? null, recipient ?? null, serial);
}

interface SerialRow {
  serial: string;
  payload: string;
  status: string;
  created_at: number;
  reconciled_tx: string | null;
  reconciled_amount: string | null;
  recipient: string | null;
  outcome: string | null;
}

function rowToSerial(r: SerialRow): PendingSerial {
  return {
    serial: r.serial,
    payload: r.payload,
    status: r.status as PendingSerial["status"],
    createdAt: r.created_at,
    reconciledTx: r.reconciled_tx ?? undefined,
    reconciledAmount: r.reconciled_amount ?? undefined,
    recipient: r.recipient ?? undefined,
    outcome: (r.outcome as PendingSerial["outcome"]) ?? undefined,
  };
}
