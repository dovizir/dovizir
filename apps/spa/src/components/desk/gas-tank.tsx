"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
// @ts-expect-error — plain-JS ledger, tested standalone (gas-tank.test.mjs)
import { tankLedger, tankView } from "@/lib/embedded/gas-tank.mjs";

/**
 * The sarraf's prepaid gas tank (mvp.md "Gas billing", at-cost, decided
 * 2026-08-20): balance, burn, runway, arrears, and the low warning.
 *
 * Numbers come from the tankLedger reducer — the same module whose invariants
 * are pinned by gas-tank.test.mjs (attribution, at-cost, degradation, warn
 * before exhaustion) — so this panel cannot disagree with the billing logic.
 *
 * DATA SEAM: events are demo-seeded until the maintainer's billing feed lands
 * (top-ups from the payment flow, sponsorships attributed per userop by the
 * paymaster service). The seam is the event array alone; the maths above it is
 * final and tested.
 */
const DEMO_SARRAF = "0xdemo";
const DAY = 86_400_000;
const NOW = Date.parse("2026-08-20T12:00:00Z");
const DEMO_EVENTS = [
  { kind: "topUp", sarraf: DEMO_SARRAF, usdt: 25, at: NOW - 9 * DAY },
  // a week of sponsored transfers at Base-scale gas costs
  ...Array.from({ length: 7 }, (_, d) => ({
    kind: "sponsor",
    sarraf: DEMO_SARRAF,
    gasWei: 150_000_000_000_000n, // ~0.00015 ETH
    ethUsdtRate: 3000,
    at: NOW - (6 - d) * DAY,
  })),
];

export function GasTank() {
  const t = useTranslations("desk");

  const view = useMemo(() => {
    const ledger = tankLedger(DEMO_EVENTS);
    return tankView(ledger[DEMO_SARRAF], NOW);
  }, []);

  const pct =
    view.daysRemaining === null
      ? 100
      : Math.max(2, Math.min(100, Math.round((view.daysRemaining / 30) * 100)));

  return (
    <section className="rounded-lg bg-surface p-lg shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t("gasTank")}</h2>
        {view.low && (
          <span className="rounded-pill bg-danger px-sm py-[2px] text-[10px] font-medium text-primary-foreground">
            {t("gasTankLow")}
          </span>
        )}
      </div>
      <p className="mt-xs text-xs text-muted">{t("gasTankHint")}</p>

      <div className="mt-md flex items-baseline gap-xs" dir="ltr">
        <span className="font-heading text-2xl font-bold text-foreground">
          {view.balanceUsdt.toFixed(2)}
        </span>
        <span className="text-sm text-muted">USDT</span>
      </div>

      <div className="mt-sm h-2 w-full overflow-hidden rounded-pill bg-surface-alt">
        <div
          className={`h-full rounded-pill ${view.low ? "bg-danger" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <dl className="mt-md grid grid-cols-2 gap-sm text-xs">
        <div>
          <dt className="text-muted">{t("gasTankBurn")}</dt>
          <dd className="font-medium text-foreground" dir="ltr">
            {view.burnPerDayUsdt.toFixed(2)} USDT
          </dd>
        </div>
        <div>
          <dt className="text-muted">{t("gasTankRunway")}</dt>
          <dd className="font-medium text-foreground" dir="ltr">
            {view.daysRemaining === null ? "—" : t("gasTankDays", { days: view.daysRemaining })}
          </dd>
        </div>
        {view.owedUsdt > 0 && (
          <div className="col-span-2">
            <dt className="text-muted">{t("gasTankOwed")}</dt>
            <dd className="font-medium text-danger" dir="ltr">
              {view.owedUsdt.toFixed(2)} USDT
            </dd>
          </div>
        )}
      </dl>

      {!view.sponsorAvailable && (
        <p className="mt-sm rounded-md bg-surface-alt p-sm text-xs text-danger">
          {t("gasTankEmpty")}
        </p>
      )}

      <button
        type="button"
        disabled
        title={t("gasTankTopUpSoon")}
        className="mt-md w-full rounded-pill bg-primary px-lg py-sm text-sm font-medium text-primary-foreground opacity-60"
      >
        {t("gasTankTopUp")}
      </button>
      <p className="mt-xs text-center text-[10px] text-muted">{t("gasTankTopUpSoon")}</p>
    </section>
  );
}
