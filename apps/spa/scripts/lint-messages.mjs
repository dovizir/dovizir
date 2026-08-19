#!/usr/bin/env node
/**
 * Message lint — runs with no test runner and no dependencies.
 *
 * Two invariants that rot silently otherwise:
 *
 *  1. VOCABULARY. The instrument is "hawala"; an amount's denomination is the
 *     Dovizir-marked USDT. "IOU" is retired from every user-visible string.
 *     A blind find-replace cannot do this job — the two senses take different
 *     words — so the lint only proves the old term is gone, and the two senses
 *     are checked by their own assertions below.
 *
 *  2. PARITY. Every locale carries every key. A missing key does not crash;
 *     it silently renders English (or a raw key) to a user who cannot read it,
 *     which is the worst kind of bug in a product whose whole premise is
 *     serving people in their own language.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const MESSAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "messages");

/** Locales the product ships. Kept explicit so a missing FILE fails the lint
 *  rather than silently shrinking the matrix. */
const EXPECTED_LOCALES = ["en", "tr", "ar", "fa", "ur", "fa-AF", "ckb", "ps"];

/** Retired vocabulary, and what replaced it.
 *
 *  Transliterations matter: a locale can "remove IOU" while still spelling it
 *  out in its own script, which an ASCII-only check sails straight past. One
 *  such case (fa: آی‌اویو) was caught by a human pass, not by this lint —
 *  hence these entries. */
const FORBIDDEN = [
  { term: "IOU", why: 'retired — the instrument is "hawala", amounts are marked USDT' },
  { term: "آی‌اویو", why: "Persian/Dari transliteration of IOU — use حواله" },
  { term: "آی او یو", why: "Persian/Dari transliteration of IOU — use حواله" },
  { term: "آي أو يو", why: "Arabic transliteration of IOU — use حوالة" },
  { term: "آئی او یو", why: "Urdu transliteration of IOU — use حوالہ" },
  { term: "ئای ئۆ یو", why: "Sorani transliteration of IOU — use حەوالە" },
  { term: "USDT-IOU", why: "old compound unit — an amount's denomination is plain USDT" },
];

const flatten = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v) ? flatten(v, key) : [[key, v]];
  });

const failures = [];
const present = readdirSync(MESSAGES).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json"));

for (const locale of EXPECTED_LOCALES) {
  if (!present.includes(locale)) failures.push(`[parity] locale file missing entirely: ${locale}.json`);
}

const loaded = Object.fromEntries(
  present.map((l) => [l, Object.fromEntries(flatten(JSON.parse(readFileSync(join(MESSAGES, `${l}.json`), "utf8"))))]),
);

// 1. vocabulary
for (const [locale, entries] of Object.entries(loaded)) {
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== "string") continue;
    for (const { term, why } of FORBIDDEN) {
      if (value.includes(term)) failures.push(`[vocab] ${locale}: "${key}" still contains "${term}" — ${why}`);
    }
  }
}

// 2. ICU argument parity. A dropped or renamed {amount} does not throw — it
//    renders a broken string to the user. Match only ARGUMENT names: a token
//    directly after "{" that is followed by "," or "}". Naively matching every
//    "{word" instead picks up the first word inside each plural branch, which
//    legitimately differs per language.
const icuArgs = (v) => new Set([...String(v).matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]));
for (const [locale, entries] of Object.entries(loaded)) {
  if (locale === "en") continue;
  for (const [key, value] of Object.entries(entries)) {
    const src = loaded.en?.[key];
    if (typeof value !== "string" || typeof src !== "string") continue;
    const want = icuArgs(src), got = icuArgs(value);
    if (want.size !== got.size || [...want].some((a) => !got.has(a))) {
      failures.push(
        `[icu] ${locale}: "${key}" placeholders {${[...got]}} != en {${[...want]}}`,
      );
    }
  }
}

// 3. parity, measured against English as the source of truth
const enKeys = Object.keys(loaded.en ?? {});
for (const [locale, entries] of Object.entries(loaded)) {
  if (locale === "en") continue;
  const missing = enKeys.filter((k) => !(k in entries));
  if (missing.length) {
    failures.push(
      `[parity] ${locale}: ${missing.length} key(s) missing vs en — e.g. ${missing.slice(0, 3).join(", ")}`,
    );
  }
}

if (failures.length) {
  console.error(`\nmessage lint FAILED — ${failures.length} problem(s):\n`);
  for (const f of failures.slice(0, 25)) console.error("  " + f);
  if (failures.length > 25) console.error(`  … and ${failures.length - 25} more`);
  console.error("");
  process.exit(1);
}
console.log(`message lint passed — ${EXPECTED_LOCALES.length} locales, ${enKeys.length} keys each`);
