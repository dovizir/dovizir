/** One-shot sync to chain head (no server) — handy for the e2e proof. */
import { addressesConfigured, loadConfig, makeClient } from "./config.js";
import { eventCount, openDb } from "./db.js";
import { buildSources, syncOnce } from "./sync.js";

async function main() {
  const cfg = await loadConfig();
  if (!addressesConfigured(cfg)) {
    console.error("[sync] addresses unset — run Deploy.s.sol / set *_ADDRESS env first");
    process.exit(1);
  }
  const db = openDb(cfg.dbPath);
  const client = makeClient(cfg.rpcUrl);
  const sources = buildSources(cfg);
  const head = await syncOnce({ db, cfg, client, sources, log: (m) => console.log(`[sync] ${m}`) });
  console.log(`[sync] done — head ${head}, ${eventCount(db)} events in ${cfg.dbPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
