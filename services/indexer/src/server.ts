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
import { buildSources, runSyncLoop } from "./sync.js";
import { memberView, sarrafView, snapshot } from "./store.js";
import { networkStats, sarrafPnl } from "./derive.js";

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address");
const serialSubmit = z.object({
  serial: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "serial must be bytes32 hex"),
  payload: z.string().min(1),
});

async function main() {
  const cfg = await loadConfig();
  const db = openDb(cfg.dbPath);
  const app = Fastify({ logger: false });
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

  app.get("/member/:addr", async (req, reply) => {
    const parsed = addr.safeParse((req.params as { addr: string }).addr);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return memberView(allEvents(db), parsed.data);
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
