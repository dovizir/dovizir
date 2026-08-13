import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { defaultLocale, isLocale, LOCALE_COOKIE } from "./config";

type Messages = Record<string, unknown>;

/** Untranslated locales fall back key-by-key to English. */
function deepMerge(base: Messages, override: Messages): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Messages, value as Messages);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : defaultLocale;

  const fallback = (await import("../messages/en.json")).default as Messages;
  const messages =
    locale === "en"
      ? fallback
      : deepMerge(
          fallback,
          (await import(`../messages/${locale}.json`)).default as Messages,
        );

  return { locale, messages };
});
