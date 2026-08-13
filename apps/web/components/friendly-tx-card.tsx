"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useFriendlyTx } from "@/lib/hooks";

/**
 * "1 free friendly tx/day" — the killer feature, UI stub for M2.
 * Quota display comes from the local useFriendlyTx stub; real enforcement
 * arrives with the paymaster sponsorship policy.
 */
export function FriendlyTxCard() {
  const t = useTranslations("friendly");
  const { remainingToday, hydrated } = useFriendlyTx();

  return (
    <section className="rounded-lg border border-primary/30 bg-surface p-xl shadow-card">
      <div className="flex items-center justify-between gap-md">
        <h2 className="text-lg font-medium text-foreground">{t("title")}</h2>
        <span
          className={`rounded-pill px-md py-xs text-xs font-bold ${
            !hydrated || remainingToday > 0
              ? "bg-success/15 text-success"
              : "bg-warning/15 text-warning"
          }`}
        >
          {!hydrated || remainingToday > 0 ? t("badge") : t("usedBadge")}
        </span>
      </div>
      <p className="mt-sm text-sm text-muted">{t("body")}</p>
      {hydrated && (
        <p className="mt-sm text-xs text-muted">
          {t("remaining", { count: remainingToday })}
        </p>
      )}
      <Link
        href="/send?friendly=1"
        className="mt-lg inline-block rounded-pill bg-primary px-xl py-sm text-sm font-bold text-primary-foreground"
      >
        {t("cta")}
      </Link>
    </section>
  );
}
