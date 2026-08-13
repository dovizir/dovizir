"use client";

import { useTranslations } from "next-intl";

/**
 * Paymaster gas-tank monitor — PLACEHOLDER.
 *
 * Reads a mock balance. The real reading needs the Pimlico paymaster
 * integration (ERC-4337 sponsored gas), which lands with AA-SEAM and requires
 * a Pimlico API key. Until then this shows a static tank so the desk chrome and
 * i18n are ready to wire.
 */
const MOCK_BALANCE_ETH = 0.412;
const MOCK_CAPACITY_ETH = 1.0;

export function GasTank() {
  const t = useTranslations("desk");
  const pct = Math.round((MOCK_BALANCE_ETH / MOCK_CAPACITY_ETH) * 100);
  const low = pct < 25;

  return (
    <section className="rounded-lg bg-surface p-lg shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t("gasTank")}</h2>
        <span className="rounded-pill bg-surface-alt px-sm py-[2px] text-[10px] font-medium text-muted">
          {t("gasTankStub")}
        </span>
      </div>
      <p className="mt-xs text-xs text-muted">{t("gasTankHint")}</p>

      <div className="mt-md flex items-baseline gap-xs">
        <span className="font-heading text-2xl font-bold text-foreground" dir="ltr">
          {MOCK_BALANCE_ETH.toFixed(3)}
        </span>
        <span className="text-sm text-muted" dir="ltr">
          / {MOCK_CAPACITY_ETH.toFixed(1)} ETH
        </span>
      </div>
      <div className="mt-sm h-2 w-full overflow-hidden rounded-pill bg-surface-alt">
        <div
          className={`h-full rounded-pill ${low ? "bg-danger" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-sm text-[10px] text-muted">{t("gasTankPimlico")}</p>
    </section>
  );
}
