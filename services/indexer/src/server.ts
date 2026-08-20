/**
 * Dovizir indexer REST API (Fastify). Boots the SQLite store, kicks off the
 * background event-sync loop, and serves derived state for the Sarraf desk.
 *
 * Endpoints:
 *   GET  /health                 liveness + sync cursor
 *   GET  /stats                  network totals
 *   GET  /snapshot               desk payload (stats + every sarraf book)
 *   GET  /sarraf/:addr           coverage + cert + members + computed credit + pnl
 *   GET  /sarraf/:addr/pnl       act-2 yardstick P&L only
 *   GET  /member/:addr           balance, sponsor, tx history
 *   GET  /serials/pending        offline-notes pending feed
 *   GET  /serials/:serial        spent | pending | unknown
 *   POST /serials                submit a spend transcript { serial, payload }
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { addressesConfigured, loadConfig, makeClient } from "./config.js";
import {
  eventCount,
  getLastBlock,
  getPendingSerials,
  getSerial,
  insertPendingSerial,
  openDb,
} from "./db.js";
import { allEvents } from "./db.js";
import { insuranceView } from "./insurance.js";
import {
  initDirectorySchema,
  registerContact,
  resolveContact,
} from "./directory.js";
import { buildSources, runSyncLoop } from "./sync.js";
import { memberView, sarrafView, snapshot } from "./store.js";
import { networkStats, sarrafPnl } from "./derive.js";
import { initRampSchema } from "./ramp-store.js";
import { registerRampRoutes } from "./ramp-routes.js";
import { initP2pSchema } from "./p2p-store.js";
import { registerP2pRoutes } from "./p2p-routes.js";

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address");
const serialSubmit = z.object({
  serial: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "serial must be bytes32 hex"),
  payload: z.string().min(1),
});

async function main() {
  const cfg = await loadConfig();
  const db = openDb(cfg.dbPath);
  initRampSchema(db);
  initP2pSchema(db);
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  const configured = addressesConfigured(cfg);
  const stop = { stopped: false };
  if (configured) {
    const client = makeClient(cfg.rpcUrl);
    const sources = buildSources(cfg);
    void runSyncLoop({ db, cfg, client, sources, log: (m) => console.log(`[sync] ${m}`) }, stop);
  } else {
    console.warn(
      "[indexer] contract addresses unset — API serving empty state. " +
        "Run Deploy.s.sol and point DEPLOYMENTS_DIR/CHAIN_ID at it.",
    );
  }

  const now = () => Math.floor(Date.now() / 1000);

  app.get("/health", async () => ({
    ok: true,
    chainId: cfg.chainId,
    configured,
    lastSyncedBlock: getLastBlock(db, cfg.startBlock).toString(),
    events: eventCount(db),
  }));

  app.get("/stats", async () => networkStats(allEvents(db)));

  app.get("/snapshot", async () => snapshot(db, now()));

  app.get("/sarraf/:addr", async (req, reply) => {
    const parsed = addr.safeParse((req.params as { addr: string }).addr);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return sarrafView(allEvents(db), parsed.data, now());
  });

  app.get("/sarraf/:addr/pnl", async (req, reply) => {
    const parsed = addr.safeParse((req.params as { addr: string }).addr);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return sarrafPnl(allEvents(db), parsed.data);
  });

  app.get("/sarraf/:addr/insurance", async (req, reply) => {
    const parsed = addr.safeParse((req.params as { addr: string }).addr);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return insuranceView(allEvents(db), parsed.data);
  });

  app.get("/member/:addr", async (req, reply) => {
    const parsed = addr.safeParse((req.params as { addr: string }).addr);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return memberView(allEvents(db), parsed.data);
  });

  // ---- contact directory (Phase 3 / G6) --------------------------------
  // The pepper lives ONLY in the environment. Unset => the directory answers
  // 503 rather than silently running with a hardcoded key — a default pepper
  // would make every deployment's hashes mutually crackable.
  const DIR_PEPPER = process.env.DIRECTORY_PEPPER ?? "";
  const DIR_ADMIN = process.env.DIRECTORY_ADMIN_TOKEN ?? "";
  initDirectorySchema(db);

  app.post("/directory/register", async (req, reply) => {
    if (!DIR_PEPPER || !DIR_ADMIN) return reply.code(503).send({ error: "directory not configured" });
    // Registration re-points an identifier at a wallet, so an open endpoint
    // would let anyone hijack a phone number. Desk-held token in the pilot;
    // OTP-verified self-serve replaces this with the onboarding flow.
    if (req.headers["x-directory-admin"] !== DIR_ADMIN) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = z
      .object({ identifier: z.string().min(3).max(200), wallet: addr })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    registerContact(db, DIR_PEPPER, body.data.identifier, body.data.wallet);
    return reply.code(201).send({ ok: true });
  });

  app.get("/directory/resolve", async (req, reply) => {
    if (!DIR_PEPPER) return reply.code(503).send({ error: "directory not configured" });
    const q = z
      .object({ id: z.string().min(3).max(200) })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    // Rate-limit key: the caller's network identity. A spoofable body field
    // would let a scanner mint fresh requesters per call.
    const requester = req.ip;
    try {
      const hit = resolveContact(db, DIR_PEPPER, q.data.id, requester, now() * 1000);
      return { wallet: hit?.wallet ?? null };
    } catch (e) {
      if (String(e).includes("rate limited")) return reply.code(429).send({ error: "rate limited" });
      throw e;
    }
  });

  app.get("/serials/pending", async () => ({ pending: getPendingSerials(db) }));

  app.get("/serials/:serial", async (req, reply) => {
    const serial = (req.params as { serial: string }).serial.toLowerCase();
    if (!/^0x[0-9a-fA-F]{64}$/.test(serial)) {
      return reply.code(400).send({ error: "serial must be bytes32 hex" });
    }
    const row = getSerial(db, serial);
    if (!row) return { serial, status: "unknown" as const };
    return row;
  });

  // Fiat-ramp product layer: rates, RFQ, on/off-ramp orders + receipt evidence.
  registerRampRoutes(app, { db, chainId: cfg.chainId });

  // P2P escrow order book (fiat-ramp §4): escrow-event mirror + receipt/chat/bank.
  registerP2pRoutes(app, { db });

  app.post("/serials", async (req, reply) => {
    const parsed = serialSubmit.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const serial = parsed.data.serial.toLowerCase();
    const existing = getSerial(db, serial);
    if (existing && existing.status === "spent") {
      return reply.code(409).send({ error: "serial already settled on-chain", serial, status: existing });
    }
    insertPendingSerial(db, serial, parsed.data.payload, now());
    return reply.code(201).send({ serial, status: "pending" });
  });

  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  console.log(
    `[indexer] API on :${cfg.port} — chain ${cfg.chainId}, ${configured ? "syncing" : "idle (unconfigured)"}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
