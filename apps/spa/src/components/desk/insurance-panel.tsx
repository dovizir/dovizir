"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { indexer, type SarrafInsuranceView } from "@/lib/indexer";

/** 6-dp USDT string -> display units. */
function fmt(usdt6: string): string {
  const n = Number(usdt6) / 1e6;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * The income side of the desk, from PurchaseInsurance events via the indexer's
 * /sarraf/:addr/insurance (reducer pinned by 17 tests). Sits beside the gas
 * tank: what sponsorship costs on one card, what underwriting earns on this
 * one — together the sarraf's P&L for the purchase business.
 */
export function InsurancePanel({ sarraf }: { sarraf: string }) {
  const t = useTranslations("desk");
  const q = useQuery<SarrafInsuranceView>({
    queryKey: ["indexer", "insurance", sarraf],
    refetchInterval: 5_000,
    retry: 1,
    queryFn: ({ signal }) => indexer.insurance(sarraf, signal),
  });

  return (
    <section className="rounded-lg bg-surface p-lg shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t("insurance")}</h2>
        {q.data && q.data.strikes > 0 && (
          <span className="rounded-pill bg-danger px-sm py-[2px] text-[10px] font-medium text-primary-foreground">
            {t("insuranceStrikes", { count: q.data.strikes })}
          </span>
        )}
      </div>
      <p className="mt-xs text-xs text-muted">{t("insuranceHint")}</p>

      {!q.data ? (
        <p className="mt-md text-sm text-muted">{q.isError ? t("insuranceUnavailable") : "…"}</p>
      ) : (
        <>
          <div className="mt-md flex items-baseline gap-xs" dir="ltr">
            <span className="font-heading text-2xl font-bold text-foreground">
              {fmt(q.data.withdrawable)}
            </span>
            <span className="text-sm text-muted">USDT</span>
          </div>
          <p className="text-xs text-muted">{t("insuranceWithdrawable")}</p>

          <dl className="mt-md grid grid-cols-2 gap-sm text-xs">
            <div>
              <dt className="text-muted">{t("insuranceEarned")}</dt>
              <dd className="font-medium text-foreground" dir="ltr">{fmt(q.data.earned)} USDT</dd>
            </div>
            <div>
              <dt className="text-muted">{t("insuranceUnearned")}</dt>
              <dd className="font-medium text-foreground" dir="ltr">{fmt(q.data.unearned)} USDT</dd>
            </div>
            <div>
              <dt className="text-muted">{t("insuranceBonds")}</dt>
              <dd className="font-medium text-foreground" dir="ltr">
                {fmt(q.data.bondsUnderManagement)} USDT · {t("insuranceShops", { count: q.data.shopCount })}
              </dd>
            </div>
            <div>
              <dt className="text-muted">{t("insuranceExposure")}</dt>
              <dd className="font-medium text-foreground" dir="ltr">{fmt(q.data.outstandingExposure)} USDT</dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}
