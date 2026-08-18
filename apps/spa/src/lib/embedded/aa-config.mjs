/**
 * Where the 4337 bundler and paymaster live.
 *
 * Deliberately a thin config layer rather than a vendor SDK wrapper, because
 * the vendor is the part most likely to change. Pimlico is the starting choice
 * (best ERC-20 token-paymaster support, and its bundler `alto` is open source,
 * so self-hosting later is a deployment change rather than a rewrite) — but
 * nothing in this module knows that.
 *
 * Why a LIST of bundlers: a bundler is a chokepoint operated by someone else.
 * If a user's UserOperation is refused there, it never reaches the chain, and
 * "no one can hold your money hostage" fails at the infrastructure layer rather
 * than the contract layer. Our users are in corridors where a regulated
 * provider may be compelled to cut them off, so a fallback — ultimately a
 * self-hosted one — is a requirement, not an optimisation.
 *
 * Why absence must degrade: mvp.md §4 — no off-chain service may strand a user.
 * With nothing configured the app runs the legacy embedded-key path instead of
 * failing to start.
 */

/** Query parameters known to carry provider secrets. */
const SECRET_PARAMS = /([?&](?:api[-_]?key|apikey|key|token)=)([^&]+)/gi;

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{enabled: boolean, bundlerUrls: string[], paymasterUrl?: string, reason: string}}
 */
export function resolveAaConfig(env = {}) {
  const raw = (env.NEXT_PUBLIC_BUNDLER_URL ?? "").trim();
  const bundlerUrls = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (bundlerUrls.length === 0) {
    return { enabled: false, bundlerUrls: [], reason: "no-bundler-configured" };
  }

  const paymasterUrl = (env.NEXT_PUBLIC_PAYMASTER_URL ?? "").trim() || undefined;
  return {
    enabled: true,
    bundlerUrls,
    paymasterUrl,
    // A bundler without a paymaster is a legitimate configuration: the account
    // still works, the user just funds their own gas.
    reason: paymasterUrl ? "ready" : "bundler-only-no-sponsorship",
  };
}

/**
 * Make an endpoint safe to log. Bundler URLs embed the API key, so any error
 * message, breadcrumb, or console line that includes one leaks a credential.
 *
 * Known limit: providers that put the key in the PATH (`/rpc/<key>`) rather
 * than a query parameter are not covered — the shape is provider-specific and
 * guessing would give false confidence. Prefer query-parameter endpoints, and
 * extend this if a path-keyed provider is adopted.
 */
export function redactEndpoint(url) {
  if (!url) return "<unset>";
  return String(url).replace(SECRET_PARAMS, "$1***");
}
