/**
 * Locale scaffold: 7 locales, en + fa fully translated; the rest fall back to
 * English (their message files deep-merge over en at request time).
 */
export const locales = ["en", "fa", "ar", "tr", "ur", "ru", "zh"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

/** Right-to-left locales — drives <html dir> and the Vazirmatn font swap. */
export const rtlLocales: ReadonlySet<string> = new Set(["fa", "ar", "ur"]);

export const localeNames: Record<Locale, string> = {
  en: "English",
  fa: "فارسی",
  ar: "العربية",
  tr: "Türkçe",
  ur: "اردو",
  ru: "Русский",
  zh: "中文",
};

/** Cookie used to persist the user's locale choice. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: string | undefined): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}

export function dirOf(locale: string): "rtl" | "ltr" {
  return rtlLocales.has(locale) ? "rtl" : "ltr";
}
