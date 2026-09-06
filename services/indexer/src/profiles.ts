import { readFileSync } from "node:fs";

/**
 * Sarraf public profiles — name + logo, rendered inside the consumer app
 * (balance card, sign-up sponsor screen).
 *
 * The store is a maintainer-owned JSON file (the maintainer console will own
 * writes; until then it is hand-edited). Two rules carry the security weight
 * (design: sarraf-onboarding.md §2):
 *
 *  - branding is served ONLY for certified sarrafs — certification is
 *    permissionless, so file-listing alone must never brand our surfaces;
 *  - everything fails CLOSED: bad file, bad entry, bad field → no branding.
 */

export interface SarrafProfile {
  name: string;
  logo?: string;
}

export type ProfileMap = Record<string, SarrafProfile>;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function loadProfiles(path: string): ProfileMap {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

  const out: ProfileMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ADDRESS_RE.test(key)) continue;
    if (typeof value !== "object" || value === null) continue;
    const { name, logo } = value as { name?: unknown; logo?: unknown };
    if (typeof name !== "string" || name.trim() === "") continue;
    const profile: SarrafProfile = { name };
    if (typeof logo === "string" && logo.trim() !== "") profile.logo = logo;
    out[key.toLowerCase()] = profile;
  }
  return out;
}

/** The certified gate: a profile exists AND the chain says certified. */
export function profileFor(
  profiles: ProfileMap,
  sarraf: string,
  certified: boolean,
): SarrafProfile | null {
  if (!certified) return null;
  return profiles[sarraf.toLowerCase()] ?? null;
}
