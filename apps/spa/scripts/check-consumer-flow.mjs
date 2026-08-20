#!/usr/bin/env node
/**
 * The consumer journey, end to end, plus the two promises the MVP plan makes
 * about every screen (mvp-build-plan.md Phase 4):
 *
 *   "no screen anywhere exposes a seed phrase or requires ETH"
 *
 * So beyond walking the routes, every screen's text is checked against a
 * forbidden vocabulary. A single mention of a seed phrase or a demand for ETH
 * on a consumer surface is a product failure regardless of whether the code
 * "works" — the audience this app exists for does not have ETH and must never
 * be asked to.
 *
 * Onboarding runs the REAL passkey ceremony via CDP's virtual authenticator —
 * the same discipline as check-locale-switch: drive the actual control, not
 * the storage behind it.
 *
 * Needs a preview server (`npx vite preview --port 3200`); skips cleanly
 * without one or without playwright-core, so it never blocks a build.
 */
const BASE = process.env.SPA_URL ?? "http://localhost:3200";

const ROUTES = [
  "/", "/send", "/redeem", "/deposit", "/cash-in", "/cash-out",
  "/rates", "/market", "/notes",
];

/** Things a consumer screen must never say. Case-insensitive, text-level. */
const FORBIDDEN = [
  { re: /seed\s*phrase/i, why: "seed phrases must not exist in this product" },
  { re: /mnemonic/i, why: "same" },
  { re: /private\s*key/i, why: "key material is never a user concern" },
  { re: /\bETH\b(?!ereum)/, why: "a consumer must never be asked about ETH" },
  { re: /\bIOU\b/, why: "retired vocabulary (Phase 0.5)" },
];

let pw;
try {
  pw = (await import("playwright-core")).default ?? (await import("playwright-core"));
} catch {
  console.log("check-consumer-flow: playwright-core not installed — skipped");
  process.exit(0);
}
try {
  const r = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(String(r.status));
} catch {
  console.log(`check-consumer-flow: no server at ${BASE} — skipped`);
  process.exit(0);
}

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const problems = [];

// --- onboarding: the real ceremony ---------------------------------------
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
await page.goto(BASE, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(1000);
await page.click('button:has-text("Create your wallet")').catch(() => {
  problems.push("onboarding: the create-wallet button was not found");
});
await page.waitForSelector('button:has-text("0x")', { timeout: 20_000 }).catch(() => {
  problems.push("onboarding: no connected address appeared after the ceremony");
});
const leakedKey = await page.evaluate(() => localStorage.getItem("dovizir.embedded.pk"));
if (leakedKey) problems.push("onboarding: a raw private key was written despite the passkey path");

// --- every screen: renders, and says nothing forbidden --------------------
for (const route of ROUTES) {
  await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(700);
  const text = await page.evaluate(() => document.body.innerText || "");
  if (text.trim().length < 20) problems.push(`${route}: renders (almost) nothing`);
  for (const { re, why } of FORBIDDEN) {
    const m = text.match(re);
    if (m) problems.push(`${route}: says "${m[0]}" — ${why}`);
  }
}

// --- the balance is denominated, not just a number ------------------------
await page.goto(BASE, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(700);
const hasUnit = await page.evaluate(() => (document.body.innerText || "").includes("USDT"));
if (!hasUnit) problems.push("/: the balance shows no USDT denomination");

await browser.close();

if (problems.length) {
  console.error(`\ncheck-consumer-flow: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error("  ✗ " + p);
  console.error("");
  process.exit(1);
}
console.log(
  `check-consumer-flow: clean — onboarding + ${ROUTES.length} screens, nothing forbidden`,
);
