#!/usr/bin/env node
/**
 * The locale switcher actually switches.
 *
 * This exists because it once did not. The switcher was a Next.js leftover
 * that wrote a NEXT_LOCALE cookie and called router.refresh(); after the Vite
 * migration there was no server to read the cookie and no refresh to trigger,
 * so ONLY English was reachable. Every message file was perfect, the lint was
 * green, and the product shipped one language.
 *
 * The lesson in the test design: it drives the REAL <select> with a real change
 * event. An earlier check set localStorage directly and passed the whole time
 * the switcher was dead.
 *
 * Needs a dev/preview server: `npx vite preview --port 3200`.
 */
const BASE = process.env.SPA_URL ?? "http://localhost:3200";
const CASES = [
  { locale: "tr", dir: "ltr" },
  { locale: "ar", dir: "rtl" },
  { locale: "fa", dir: "rtl" },
  { locale: "ps", dir: "rtl" },
];

let pw;
try {
  pw = (await import("playwright-core")).default ?? (await import("playwright-core"));
} catch {
  console.log("check-locale-switch: playwright-core not installed — skipped");
  process.exit(0);
}
try {
  const r = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(String(r.status));
} catch {
  console.log(`check-locale-switch: no server at ${BASE} — skipped`);
  process.exit(0);
}

const browser = await pw.chromium.launch();
const failures = [];

for (const { locale, dir } of CASES) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(600);

  // Drive the actual control, exactly as a user would.
  const sel = await page.evaluateHandle((l) =>
    [...document.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === l),
    ), locale);
  const el = sel.asElement();
  if (!el) { failures.push(`${locale}: no select offers this locale`); await ctx.close(); continue; }
  await el.selectOption(locale);
  await page.waitForTimeout(900);

  const got = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
  }));
  if (got.lang !== locale) failures.push(`${locale}: selecting it left lang="${got.lang}"`);
  if (got.dir !== dir) failures.push(`${locale}: expected dir="${dir}", got "${got.dir}"`);

  // And it must survive a reload, or the choice is not really persisted.
  await page.reload({ waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => document.documentElement.lang);
  if (after !== locale) failures.push(`${locale}: not persisted — reload reverted to "${after}"`);

  await ctx.close();
}
await browser.close();

if (failures.length) {
  console.error(`\ncheck-locale-switch: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error("  ✗ " + f);
  console.error("");
  process.exit(1);
}
console.log(`check-locale-switch: clean — ${CASES.length} locales switch and persist`);
