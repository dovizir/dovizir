/**
 * Stale-chunk recovery policy (see chunk-error.test.mjs for the why).
 *
 * Pure logic only — the router's error boundary owns the side effects
 * (sessionStorage flag + location.reload()).
 */

/** The wordings the three engines use when a hashed chunk 404s mid-import. */
const CHUNK_LOAD_PATTERNS = [
  /failed to fetch dynamically imported module/i, // chromium
  /importing a module script failed/i, //            webkit
  /error loading dynamically imported module/i, //   firefox
];

/** True only for dynamic-import failures — never for ordinary crashes. */
export function isChunkLoadError(error) {
  const message =
    typeof error === "string"
      ? error
      : error && typeof error.message === "string"
        ? error.message
        : null;
  if (message === null) return false;
  return CHUNK_LOAD_PATTERNS.some((re) => re.test(message));
}

/** Reload at most once per session; anything unclear fails closed (no reload). */
export function shouldAutoReload(state) {
  return !!state && state.alreadyReloaded === false;
}
