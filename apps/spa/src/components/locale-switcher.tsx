"use client";

import { useTranslations } from "next-intl";
import { localeNames, locales, type Locale } from "@/i18n/config";
import { useLocaleSwitch } from "@/i18n/provider";

/**
 * Switches locale through the I18nProvider.
 *
 * It previously wrote a NEXT_LOCALE cookie and called router.refresh() — the
 * Next.js server-side i18n flow, which survived the Vite migration and quietly
 * stopped working: there is no server to read that cookie, and refresh() does
 * not re-render a client-only provider. The select changed and nothing else
 * did, so ONLY English was reachable. setLocale updates React state (and
 * persists to localStorage) directly.
 */
export function LocaleSwitcher() {
  const { locale, setLocale } = useLocaleSwitch();
  const t = useTranslations("locale");

  function onChange(next: string) {
    setLocale(next as Locale);
  }

  return (
    <label className="inline-flex items-center gap-sm">
      <span className="sr-only">{t("label")}</span>
      <select
        value={locale}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[9rem] min-w-0 rounded-pill border border-border bg-surface px-md py-xs text-sm text-foreground"
      >
        {locales.map((l) => (
          <option key={l} value={l}>
            {localeNames[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
