"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { LOCALE_COOKIE, localeNames, locales } from "@/i18n/config";

/** Persists the choice in the NEXT_LOCALE cookie (read by i18n/request.ts). */
export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations("locale");
  const router = useRouter();

  function onChange(next: string) {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
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
