"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { formatFiat, ramp, type IndicativeRateRecord } from "@/lib/ramp";

const CORRIDORS = ["IRR", "TRY"] as const;

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Consumer rates board: per-sarraf indicative buy/sell for each corridor. */
export default function RatesPage() {
  const t = useTranslations("ramp.board");
  const tCommon = useTranslations("common");
  const [fiat, setFiat] = useState<(typeof CORRIDORS)[number]>("IRR");
  const unit = tCommon("unit");

  const rates = useQuery<{ rates: IndicativeRateRecord[] }>({
    queryKey: ["ramp", "rates", fiat],
    refetchInterval: 15_000,
    retry: 1,
    queryFn: () => ramp.listRates(fiat),
  });

  const list = rates.data?.rates ?? [];

  return (
    <div className="flex flex-col gap-xl">
      <header>
        <h1 className="text-xl font-medium text-foreground">{t("title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("subtitle")}</p>
      </header>

      {/* indicative disclaimer — this is guidance, not an executable price */}
      <div className="rounded-md bg-warning/10 p-md text-xs text-warning">
        <span className="font-semibold">{t("indicative")}</span> · {t("indicativeNote")}
      </div>

      {/* corridor tabs */}
      <div className="flex gap-sm">
        {CORRIDORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setFiat(c)}
            className={`rounded-pill px-lg py-sm text-sm font-medium ${
              fiat === c ? "bg-primary text-primary-foreground" : "bg-surface text-muted"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <p className="rounded-md bg-surface p-lg text-sm text-muted">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-md">
          {list.map((r) => (
            <li key={`${r.sarraf}-${r.fiat}`} className="rounded-lg bg-surface p-lg shadow-card">
              <div className="mb-md flex items-center justify-between">
                <span dir="ltr" className="font-mono text-xs text-muted">
                  {shortAddr(r.sarraf)}
                </span>
                <span className="text-[10px] text-muted">
                  {t("updated")} {new Date(r.updatedAt * 1000).toLocaleDateString()}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-md">
                <div className="rounded-md bg-success/5 p-md">
                  <p className="text-xs font-medium text-success">{t("buyRate")}</p>
                  <p dir="ltr" className="mt-xs font-heading text-lg font-bold text-foreground">
                    {formatFiat(r.buyRate)}
                  </p>
                  <p className="text-[10px] text-muted">{t("perUnit", { unit })}</p>
                </div>
                <div className="rounded-md bg-primary/5 p-md">
                  <p className="text-xs font-medium text-primary">{t("sellRate")}</p>
                  <p dir="ltr" className="mt-xs font-heading text-lg font-bold text-foreground">
                    {formatFiat(r.sellRate)}
                  </p>
                  <p className="text-[10px] text-muted">{t("perUnit", { unit })}</p>
                </div>
              </div>

              <p className="mt-md text-[11px] text-muted">
                {t("size")}: {t("sizeHint", { min: r.minUsdt, max: r.maxUsdt, unit })}
              </p>

              <div className="mt-md flex gap-sm">
                <Link
                  href={`/cash-in?sarraf=${r.sarraf}&fiat=${r.fiat}`}
                  className="flex-1 rounded-pill bg-primary py-sm text-center text-sm font-bold text-primary-foreground"
                >
                  {t("cashIn")}
                </Link>
                <Link
                  href={`/cash-out?sarraf=${r.sarraf}&fiat=${r.fiat}`}
                  className="flex-1 rounded-pill border border-primary py-sm text-center text-sm font-bold text-primary"
                >
                  {t("cashOut")}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
