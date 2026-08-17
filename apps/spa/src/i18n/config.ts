/**
 * The 7 target-market locales (ported from the Next app). All are now fully
 * translated; en remains the deep-merge fallback base. 5 of 7 are RTL.
 */
export const locales = ["en", "fa", "tr", "ar", "ur", "fa-AF", "ckb"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

/** Right-to-left locales — drives <html dir> and the Vazirmatn font swap. */
export const rtlLocales: ReadonlySet<string> = new Set(["fa", "ar", "ur", "fa-AF", "ckb"]);

export const localeNames: Record<Locale, string> = {
  en: "English",
  fa: "فارسی",
  tr: "Türkçe",
  ar: "العربية",
  ur: "اردو",
  "fa-AF": "دری",
  ckb: "کوردی",
};

/** Persisted client-side (localStorage + cookie mirror) — SPA has no server. */
export const LOCALE_COOKIE = "NEXT_LOCALE";
export const LOCALE_STORAGE = "dovizir.locale";

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}

export function dirOf(locale: string): "rtl" | "ltr" {
  return rtlLocales.has(locale) ? "rtl" : "ltr";
}
