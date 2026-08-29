#!/usr/bin/env node
/**
 * Stale-chunk recovery policy.
 *
 * After a deploy, a client holding the previous app shell requests lazy-route
 * chunks by their old hashed names, which no longer exist — every navigation
 * then dies with "Failed to fetch dynamically imported module". The recovery
 * is a full reload (the no-cache shell + autoUpdate service worker pick up the
 * new build). Two rules keep that safe:
 *
 *   1. Only CHUNK-LOAD failures trigger an automatic reload. Reloading on an
 *      arbitrary render error would turn any crash into an infinite loop.
 *   2. Reload at most once per session. If the reload didn't heal the app,
 *      show the error instead of looping.
 *
 * Run: node src/lib/chunk-error.test.mjs
 */
import { isChunkLoadError, shouldAutoReload } from "./chunk-error.mjs";

let pass = 0;
const failures = [];
const ok = (cond, what) => (cond ? pass++ : failures.push(what));

// ------------------------------------------------- classifier: true cases
ok(
  isChunkLoadError(
    new TypeError(
      "Failed to fetch dynamically imported module: https://qa.dovizir.com/assets/page-BwBq09JE.js",
    ),
  ),
  "chromium chunk failure (the exact qa error) is a chunk-load error",
);
ok(
  isChunkLoadError(new TypeError("Importing a module script failed.")),
  "safari/webkit wording is a chunk-load error",
);
ok(
  isChunkLoadError(new Error("error loading dynamically imported module")),
  "firefox wording is a chunk-load error",
);
ok(
  isChunkLoadError("Failed to fetch dynamically imported module: x"),
  "plain-string errors classify too (react-router may rethrow non-Error)",
);

// ------------------------------------------------ classifier: false cases
ok(!isChunkLoadError(new Error("boom")), "an ordinary crash is NOT a chunk-load error");
ok(
  !isChunkLoadError(new TypeError("Failed to fetch")),
  "a generic network failure (API fetch) is NOT a chunk-load error",
);
ok(!isChunkLoadError(null), "null is not a chunk-load error");
ok(!isChunkLoadError(undefined), "undefined is not a chunk-load error");
ok(!isChunkLoadError({ message: 42 }), "non-string message fails closed");

// ------------------------------------------- reload-once-per-session policy
ok(
  shouldAutoReload({ alreadyReloaded: false }) === true,
  "first chunk failure in a session auto-reloads",
);
ok(
  shouldAutoReload({ alreadyReloaded: true }) === false,
  "second failure does NOT reload again (no loops) — show the error",
);
ok(shouldAutoReload({}) === false, "missing flag fails closed: no reload");
ok(shouldAutoReload(null) === false, "null state fails closed: no reload");

// ------------------------------------------------------------------ report
if (failures.length) {
  console.error(`chunk-error: ${failures.length} failure(s)`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`chunk-error: ${pass}/${pass} assertions green`);
