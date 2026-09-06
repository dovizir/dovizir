import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfiles, profileFor } from "../src/profiles.js";

/**
 * Sarraf public profiles (name + logo) — the maintainer-owned branding store
 * (design: sarraf-onboarding.md §2). Two rules carry the security weight:
 *
 *  1. Branding renders ONLY for certified sarrafs. Certification is
 *     permissionless (deposit + TWAB), so an unreviewed party could otherwise
 *     put their name inside our app — the phishing surface mvp.md names.
 *  2. The store fails CLOSED. A malformed file or entry yields no branding,
 *     never a crash and never a partial identity.
 */

const SARRAF = "0xB62FA3E71bae7e2796e16e0da355a1022AeD570A";

function fileWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "profiles-"));
  const p = join(dir, "sarraf-profiles.json");
  writeFileSync(p, content);
  return p;
}

describe("loadProfiles", () => {
  it("loads entries keyed by address, case-insensitively", () => {
    const p = loadProfiles(
      fileWith(JSON.stringify({ [SARRAF]: { name: "Sarrafi Golestan" } })),
    );
    expect(p[SARRAF.toLowerCase()]).toEqual({ name: "Sarrafi Golestan" });
  });

  it("keeps an optional logo (data or path URL)", () => {
    const p = loadProfiles(
      fileWith(
        JSON.stringify({ [SARRAF]: { name: "Sarrafi Golestan", logo: "/logos/golestan.svg" } }),
      ),
    );
    expect(p[SARRAF.toLowerCase()]?.logo).toBe("/logos/golestan.svg");
  });

  it("fails closed on a missing file", () => {
    expect(loadProfiles("/nonexistent/profiles.json")).toEqual({});
  });

  it("fails closed on malformed JSON", () => {
    expect(loadProfiles(fileWith("{not json"))).toEqual({});
  });

  it("drops entries without a usable name", () => {
    const p = loadProfiles(
      fileWith(JSON.stringify({ [SARRAF]: { logo: "/x.svg" }, "0xnot-an-address": { name: "X" } })),
    );
    expect(p).toEqual({});
  });

  it("drops non-string logos rather than serving junk", () => {
    const p = loadProfiles(fileWith(JSON.stringify({ [SARRAF]: { name: "G", logo: 7 } })));
    expect(p[SARRAF.toLowerCase()]).toEqual({ name: "G" });
  });
});

describe("profileFor — the certified gate", () => {
  const profiles = { [SARRAF.toLowerCase()]: { name: "Sarrafi Golestan" } };

  it("returns the profile for a certified sarraf", () => {
    expect(profileFor(profiles, SARRAF, true)).toEqual({ name: "Sarrafi Golestan" });
  });

  it("returns null for an uncertified sarraf even when a profile exists", () => {
    expect(profileFor(profiles, SARRAF, false)).toBeNull();
  });

  it("returns null for an unknown sarraf", () => {
    expect(profileFor(profiles, "0x0000000000000000000000000000000000000001", true)).toBeNull();
  });
});
