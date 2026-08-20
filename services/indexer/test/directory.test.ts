/**
 * The contact directory — Phase 3 (G6), the one service that touches the
 * privacy promise: "your wallet sits behind your phone number".
 *
 * Design constraints from mvp.md §4:
 *   - identifiers are stored SALTED-HASHED: a lookup succeeds only for someone
 *     who already knows the phone number; the store can never be enumerated
 *   - a miss is indistinguishable from a never-registered identifier
 *   - lookups are rate-limited per requester (anti-enumeration)
 *   - the directory failing must never block transfers by raw wallet address
 *     (that path simply does not consult it)
 */
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import {
  initDirectorySchema,
  registerContact,
  resolveContact,
  normalizeIdentifier,
  RATE_LIMIT_PER_MINUTE,
} from "../src/directory.js";

const SECRET = "test-pepper-never-in-git";
const WALLET = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const WALLET2 = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const T0 = 1_800_000_000_000;

function db() {
  const d = openDb(":memory:");
  initDirectorySchema(d);
  return d;
}

describe("normalizeIdentifier", () => {
  it("emails: trimmed and lowercased", () => {
    expect(normalizeIdentifier("  Ali@Example.COM ")).toBe("ali@example.com");
  });
  it("phones: digits with leading +, separators stripped", () => {
    expect(normalizeIdentifier("+98 912 345-6789")).toBe("+989123456789");
    expect(normalizeIdentifier("0098 (912) 345 6789")).toBe("+989123456789");
  });
  it("the SAME number written differently resolves identically", () => {
    expect(normalizeIdentifier("+98-912-345-6789")).toBe(
      normalizeIdentifier("00989123456789"),
    );
  });
});

describe("register + resolve", () => {
  it("a known contact resolves to its wallet", () => {
    const d = db();
    registerContact(d, SECRET, "+989123456789", WALLET);
    const hit = resolveContact(d, SECRET, "+98 912 345 6789", "sarrafA", T0);
    expect(hit).toEqual({ wallet: WALLET });
  });

  it("an unknown identifier returns null — same shape as any miss", () => {
    const d = db();
    registerContact(d, SECRET, "+989123456789", WALLET);
    expect(resolveContact(d, SECRET, "+989999999999", "sarrafA", T0)).toBeNull();
  });

  it("re-registering an identifier moves it to the new wallet (device change)", () => {
    const d = db();
    registerContact(d, SECRET, "ali@example.com", WALLET);
    registerContact(d, SECRET, "ali@example.com", WALLET2);
    expect(resolveContact(d, SECRET, "ali@example.com", "sarrafA", T0)).toEqual({
      wallet: WALLET2,
    });
  });

  it("a wrong pepper resolves nothing — the hash is keyed, not just salted", () => {
    const d = db();
    registerContact(d, SECRET, "+989123456789", WALLET);
    expect(resolveContact(d, "other-pepper", "+989123456789", "sarrafA", T0)).toBeNull();
  });
});

describe("nothing readable at rest", () => {
  it("neither the identifier nor any substring of it is stored in plaintext", () => {
    const d = db();
    registerContact(d, SECRET, "+989123456789", WALLET);
    registerContact(d, SECRET, "ali@example.com", WALLET2);
    const rows = d.prepare("SELECT * FROM directory").all() as Record<string, unknown>[];
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("989123456789");
    expect(dump).not.toContain("ali@example.com");
    expect(dump).not.toContain("ali");
    // and the stored key is a fixed-length digest, not a reversible encoding
    for (const r of rows) expect(String(r.id_hash)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("anti-enumeration", () => {
  it("allows normal lookup volume", () => {
    const d = db();
    registerContact(d, SECRET, "+989123456789", WALLET);
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      // misses count too — otherwise scanning unknown numbers is free
      resolveContact(d, SECRET, `+9891234567${String(i).padStart(2, "0")}`, "sarrafA", T0 + i * 100);
    }
    // the limit is per minute; the next call inside the window must throw
    expect(() =>
      resolveContact(d, SECRET, "+989123456789", "sarrafA", T0 + 5_000),
    ).toThrow(/rate/i);
  });

  it("the window rolls: a minute later the requester can look up again", () => {
    const d = db();
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      resolveContact(d, SECRET, `+98912345${String(i).padStart(4, "0")}`, "sarrafA", T0);
    }
    expect(
      resolveContact(d, SECRET, "+989123456789", "sarrafA", T0 + 61_000),
    ).toBeNull();
  });

  it("limits are per requester — one noisy sarraf never starves another", () => {
    const d = db();
    registerContact(d, SECRET, "+989123456789", WALLET);
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      resolveContact(d, SECRET, `+98912345${String(i).padStart(4, "0")}`, "noisy", T0);
    }
    expect(resolveContact(d, SECRET, "+989123456789", "quiet", T0 + 1)).toEqual({
      wallet: WALLET,
    });
  });
});
