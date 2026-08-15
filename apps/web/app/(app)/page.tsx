"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou } from "@dovizir/sdk";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { FriendlyTxCard } from "@/components/friendly-tx-card";
import { useActivity, useIouBalance } from "@/lib/hooks";

/** Home: ONE aggregated IOU number (tranches hidden) + recent activity. */
export default function HomePage() {
  const t = useTranslations("home");
  const tCommon = useTranslations("common");
  const tRamp = useTranslations("ramp.nav");
  const { isConnected } = useAccount();
  const { total, isLoading } = useIouBalance();
  const activity = useActivity();

  return (
    <div className="flex flex-col gap-xl">
      <NotDeployedBanner />

      <section className="rounded-lg bg-primary p-xl text-primary-foreground shadow-card">
        <p className="text-sm opacity-90">{t("balanceLabel")}</p>
        <p className="mt-sm font-heading text-4xl font-extrabold" dir="ltr">
          {isLoading ? "…" : formatIou(total)}
          <span className="ms-sm text-base font-medium opacity-90">
            {tCommon("iou")}
          </span>
        </p>
        <p className="mt-sm text-xs opacity-80">{t("balanceHint")}</p>
      </section>

      <div className="grid grid-cols-3 gap-md">
        <Link
          href="/deposit"
          className="rounded-md bg-surface p-lg text-center text-sm font-medium text-foreground shadow-sm"
        >
          {t("quickDeposit")}
        </Link>
        <Link
          href="/send"
          className="rounded-md bg-surface p-lg text-center text-sm font-medium text-foreground shadow-sm"
        >
          {t("quickSend")}
        </Link>
        <Link
          href="/redeem"
          className="rounded-md bg-surface p-lg text-center text-sm font-medium text-foreground shadow-sm"
        >
          {t("quickRedeem")}
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-md">
        <Link
          href="/rates"
          className="rounded-md bg-surface p-lg text-center text-sm font-medium text-foreground shadow-sm"
        >
          {tRamp("rates")}
        </Link>
        <Link
          href="/cash-in"
          className="rounded-md bg-surface p-lg text-center text-sm font-medium text-foreground shadow-sm"
        >
          {tRamp("cashIn")}
        </Link>
        <Link
          href="/cash-out"
          className="rounded-md bg-surface p-lg text-center text-sm font-medium text-foreground shadow-sm"
        >
          {tRamp("cashOut")}
        </Link>
      </div>

      <FriendlyTxCard />

      <section>
        <h2 className="mb-md text-lg font-medium text-foreground">
          {t("activityTitle")}
        </h2>
        {!isConnected ? (
          <p className="rounded-md bg-surface p-lg text-sm text-muted">
            {tCommon("notConnected")}
          </p>
        ) : !activity.data || activity.data.length === 0 ? (
          <p className="rounded-md bg-surface p-lg text-sm text-muted">
            {t("activityEmpty")}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md bg-surface shadow-sm">
            {activity.data.map((item) => (
              <li
                key={`${item.txHash}-${item.direction}`}
                className="flex items-center justify-between gap-md p-lg"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {item.direction === "in"
                      ? t("activityReceived")
                      : t("activitySent")}
                  </p>
                  <p className="text-xs text-muted" dir="ltr">
                    {item.counterparty.slice(0, 10)}…
                  </p>
                </div>
                <span
                  dir="ltr"
                  className={`text-sm font-bold ${
                    item.direction === "in" ? "text-success" : "text-danger"
                  }`}
                >
                  {item.direction === "in" ? "+" : "−"}
                  {formatIou(item.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
