/**
 * The 7 target-market locales. en + fa fully translated; fa-AF (Dari) seeded
 * from fa (shares script + most vocabulary — needs native review); ar, tr, ur,
 * ckb fall back to English key-by-key until native translation.
 * 5 of 7 are RTL (only en, tr are LTR).
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

/** Cookie used to persist the user's locale choice. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: string | undefined): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}

export function dirOf(locale: string): "rtl" | "ltr" {
  return rtlLocales.has(locale) ? "rtl" : "ltr";
}
