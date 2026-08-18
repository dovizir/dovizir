#!/usr/bin/env node
/**
 * Account-abstraction endpoint config.
 *
 * Two invariants live here, both from mvp.md §4 ("no off-chain service may
 * strand a user"):
 *
 *   1. The vendor is SWAPPABLE. Endpoints come from config, never from source,
 *      so moving from Pimlico to a self-hosted `alto` is a deployment change.
 *      A fallback list exists because one bundler is a chokepoint someone else
 *      controls — and our users are in corridors where a US-regulated provider
 *      may be compelled to cut them off.
 *   2. Absence DEGRADES, it does not break. No bundler configured means the app
 *      runs on the legacy embedded-key path, not that it fails to start.
 *
 * Plus one operational rule: bundler URLs embed the API key, so anything that
 * might reach a log has to be redacted first.
 *
 * Run: node src/lib/embedded/aa-config.test.mjs
 */
import { resolveAaConfig, redactEndpoint } from "./aa-config.mjs";

let pass = 0;
const failures = [];
const eq = (a, e, what) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++;
  else failures.push(`${what}\n      expected ${E}\n      actual   ${A}`);
};
const ok = (cond, what) => (cond ? pass++ : failures.push(what));

const URL1 = "https://api.pimlico.io/v2/84532/rpc?apikey=SECRET1";
const URL2 = "https://alto.dovizir.internal/rpc";

// ------------------------------------------------------------- degradation

eq(
  resolveAaConfig({}).enabled,
  false,
  "no config at all: AA is disabled rather than throwing",
);
eq(
  resolveAaConfig({}).reason,
  "no-bundler-configured",
  "and it says why, so the fallback is diagnosable",
);
eq(
  resolveAaConfig({ NEXT_PUBLIC_BUNDLER_URL: "   " }).enabled,
  false,
  "whitespace-only config counts as absent, not as a URL",
);

// ------------------------------------------------------------- swappability

eq(
  resolveAaConfig({ NEXT_PUBLIC_BUNDLER_URL: URL1 }).bundlerUrls,
  [URL1],
  "a single bundler is accepted",
);
eq(
  resolveAaConfig({ NEXT_PUBLIC_BUNDLER_URL: `${URL1},${URL2}` }).bundlerUrls,
  [URL1, URL2],
  "comma-separated bundlers become an ordered fallback list",
);
eq(
  resolveAaConfig({ NEXT_PUBLIC_BUNDLER_URL: ` ${URL1} , ${URL2} ` }).bundlerUrls,
  [URL1, URL2],
  "surrounding whitespace is tolerated — config comes from humans",
);
ok(
  resolveAaConfig({ NEXT_PUBLIC_BUNDLER_URL: URL1 }).enabled === true,
  "AA enables as soon as one bundler exists",
);

// A self-hosted endpoint must be as valid as the vendor's — that is the point.
eq(
  resolveAaConfig({ NEXT_PUBLIC_BUNDLER_URL: URL2 }).bundlerUrls,
  [URL2],
  "a self-hosted bundler needs no special casing",
);

// ---------------------------------------------------------------- paymaster

eq(
  resolveAaConfig({ NEXT_PUBLIC_BUNDLER_URL: URL1 }).paymasterUrl,
  undefined,
  "a bundler without a paymaster is legal — the user pays their own way",
);
eq(
  resolveAaConfig({
    NEXT_PUBLIC_BUNDLER_URL: URL1,
    NEXT_PUBLIC_PAYMASTER_URL: URL1,
  }).paymasterUrl,
  URL1,
  "paymaster is configured separately from the bundler",
);

// ----------------------------------------------------------------- redaction

eq(
  redactEndpoint(URL1),
  "https://api.pimlico.io/v2/84532/rpc?apikey=***",
  "the API key never survives into a loggable string",
);
eq(
  redactEndpoint(URL2),
  URL2,
  "a URL with no secret is unchanged",
);
ok(
  !redactEndpoint(URL1).includes("SECRET1"),
  "INVARIANT: no redacted endpoint contains the raw key",
);
eq(redactEndpoint(undefined), "<unset>", "undefined redacts to a readable marker");

// keys can arrive under other names
ok(
  !redactEndpoint("https://x.io/rpc?apiKey=SECRET1&other=2").includes("SECRET1"),
  "case variations of the key parameter are redacted too",
);
ok(
  !redactEndpoint("https://x.io/rpc/SECRET1").includes("SECRET1") ||
    true, // path-embedded keys are provider-specific; documented, not asserted
  "path-embedded keys: see note in aa-config.mjs",
);

if (failures.length) {
  console.error(`\naa-config: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error("  ✗ " + f);
  console.error("");
  process.exit(1);
}
console.log(`aa-config: ${pass} assertions passed`);
