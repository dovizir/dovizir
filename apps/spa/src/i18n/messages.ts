import en from "../messages/en.json";
import fa from "../messages/fa.json";
import tr from "../messages/tr.json";
import ar from "../messages/ar.json";
import ur from "../messages/ur.json";
import faAF from "../messages/fa-AF.json";
import ckb from "../messages/ckb.json";
import type { Locale } from "./config";

export type Messages = typeof en;

const raw: Record<Locale, Record<string, unknown>> = {
  en,
  fa,
  tr,
  ar,
  ur,
  "fa-AF": faAF,
  ckb,
};

/** Deep-merge so any missing key in a locale falls back to the English value. */
function deepMerge<T extends Record<string, unknown>>(base: T, over: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    const b = (out as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)) {
      out[k] = deepMerge(b as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function messagesFor(locale: Locale): Messages {
  return deepMerge(en as Messages, raw[locale] ?? {});
}
