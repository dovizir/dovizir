/**
 * The contact directory (Phase 3 / G6) — phone or email to wallet, without
 * ever holding either in a readable form.
 *
 * This is the one service that touches the privacy promise ("your wallet sits
 * behind your phone number"), so its design is defensive by default:
 *
 *  - Identifiers are stored as an HMAC-SHA256 under a server-side pepper.
 *    A KEYED hash, not a plain salted one: with a public salt an attacker who
 *    steals the database can brute-force phone numbers offline in minutes —
 *    the identifier space is small. With the pepper held outside the DB, the
 *    stolen file alone resolves nothing. The same property means a lookup only
 *    works for someone who already KNOWS the identifier; the store cannot be
 *    enumerated in either direction.
 *  - A miss returns null, exactly like a never-registered identifier.
 *  - Lookups are rate-limited per requester, and MISSES COUNT: if only hits
 *    consumed the budget, scanning unknown numbers would be free — which is
 *    precisely the enumeration attack the limit exists to stop.
 *  - Transfers by raw wallet address never consult this module, so the
 *    directory failing degrades contact-picker convenience, never payment.
 *
 * In the target architecture each sarraf holds their own customers' mappings
 * and the maintainer only routes. With the pilot's single sarraf this IS the
 * sarraf-side store; the router seam arrives with the second sarraf.
 */
import { createHmac } from "node:crypto";
import type { DB } from "./db.js";

/** Lookups per requester per rolling minute. Generous for a human contact
 *  picker, hostile to a scan: enumerating 10k numbers takes a week. */
export const RATE_LIMIT_PER_MINUTE = 60;

const WINDOW_MS = 60_000;

export function initDirectorySchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS directory (
      id_hash    TEXT PRIMARY KEY,   -- hmac-sha256(pepper, normalized id); never the id
      wallet     TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS directory_lookups (
      requester  TEXT NOT NULL,
      at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS directory_lookups_by_requester
      ON directory_lookups (requester, at);
  `);
}

/**
 * One canonical spelling per identifier, or "+98 912..." and "0098912..."
 * would be two different contacts.
 *  - emails: trim + lowercase
 *  - phones: strip separators; "00" prefix becomes "+"
 */
export function normalizeIdentifier(raw: string): string {
  const s = raw.trim();
  if (s.includes("@")) return s.toLowerCase();
  let digits = s.replace(/[\s\-().]/g, "");
  if (digits.startsWith("00")) digits = "+" + digits.slice(2);
  return digits;
}

function idHash(pepper: string, identifier: string): string {
  return createHmac("sha256", pepper).update(normalizeIdentifier(identifier)).digest("hex");
}

/** Sarraf-side registration (desk-authenticated in the pilot; OTP-verified
 *  self-serve arrives with the onboarding flow). Re-registering an identifier
 *  moves it — that is the device-change path. */
export function registerContact(db: DB, pepper: string, identifier: string, wallet: string): void {
  db.prepare(
    `INSERT INTO directory (id_hash, wallet, updated_at) VALUES (?, ?, 0)
     ON CONFLICT(id_hash) DO UPDATE SET wallet = excluded.wallet`,
  ).run(idHash(pepper, identifier), wallet.toLowerCase());
}

/**
 * Resolve an identifier for `requester`. Throws on rate-limit; otherwise the
 * result for "registered elsewhere", "never registered" and "wrong pepper" is
 * the same null — a miss carries no information.
 */
export function resolveContact(
  db: DB,
  pepper: string,
  identifier: string,
  requester: string,
  now: number,
): { wallet: string } | null {
  const windowStart = now - WINDOW_MS;
  const { n } = db
    .prepare(`SELECT COUNT(*) AS n FROM directory_lookups WHERE requester = ? AND at > ?`)
    .get(requester, windowStart) as { n: number };
  if (n >= RATE_LIMIT_PER_MINUTE) throw new Error("directory: rate limited");

  // Record BEFORE resolving, so misses spend budget too (see module doc).
  db.prepare(`INSERT INTO directory_lookups (requester, at) VALUES (?, ?)`).run(requester, now);
  db.prepare(`DELETE FROM directory_lookups WHERE at <= ?`).run(windowStart);

  const row = db
    .prepare(`SELECT wallet FROM directory WHERE id_hash = ?`)
    .get(idHash(pepper, identifier)) as { wallet: string } | undefined;
  return row ? { wallet: row.wallet } : null;
}
