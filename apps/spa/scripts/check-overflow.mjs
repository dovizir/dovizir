#!/usr/bin/env node
/**
 * Layout overflow sweep across every locale.
 *
 * Translated text is longer than English almost everywhere, so a header that
 * fits "Create your wallet" can break on "جزدانەکەت دروستبکە". A DOM text
 * assertion passes either way — only geometry catches it. This is the
 * automated form of the eye-check that found the Pashto header wrapping to
 * four lines, and when first run it showed SEVEN of eight locales scrolling
 * horizontally on a small phone (English included, on /redeem).
 *
 * Needs a dev server: `npm run dev -- --port 3200` in another shell.
 * Skips cleanly when Playwright is unavailable, so it never blocks a build.
 */
const BASE = process.env.SPA_URL ?? "http://localhost:3200";
const LOCALES = ["en", "fa", "tr", "ar", "ur", "fa-AF", "ckb", "ps"];
const ROUTES = ["/", "/send", "/redeem"];
const VIEW = { width: 360, height: 780 }; // deliberately a small phone

let pw;
try {
  pw = (await import("playwright-core")).default ?? (await import("playwright-core"));
} catch {
  console.log("check-overflow: playwright-core not installed — skipped");
  process.exit(0);
}

try {
  const res = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(String(res.status));
} catch {
  console.log(`check-overflow: no dev server at ${BASE} — skipped`);
  process.exit(0);
}

const browser = await pw.chromium.launch();
const problems = [];

for (const locale of LOCALES) {
  for (const route of ROUTES) {
    const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2 });
    await ctx.addInitScript((l) => localStorage.setItem("dovizir.locale", l), locale);
    const page = await ctx.newPage();
    await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(700);

    const r = await page.evaluate(() => {
      const doc = document.documentElement;
      const wide = [...document.querySelectorAll("body *")]
        .filter((el) => el.getBoundingClientRect().width > doc.clientWidth + 1)
        .slice(0, 2)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
      return { overflow: doc.scrollWidth - doc.clientWidth, wide };
    });

    if (r.overflow > 1) problems.push(`${locale}${route}: page scrolls horizontally by ${r.overflow}px`);
    for (const w of r.wide) problems.push(`${locale}${route}: element wider than viewport — ${w}`);
    await ctx.close();
  }
}
await browser.close();

if (problems.length) {
  console.error(`\ncheck-overflow: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error("  ✗ " + p);
  console.error("");
  process.exit(1);
}
console.log(`check-overflow: clean — ${LOCALES.length} locales x ${ROUTES.length} routes at ${VIEW.width}px`);
