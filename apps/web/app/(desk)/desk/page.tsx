"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou } from "@dovizir/sdk";
import { KpiTile } from "@/components/desk/kpi-tile";
import { CoverageMeter } from "@/components/desk/coverage-meter";
import { GasTank } from "@/components/desk/gas-tank";
import { useSarrafBook } from "@/lib/hooks";
import { indexer, type NetworkStats } from "@/lib/indexer";

const fmt = (v: string) => formatIou(BigInt(v));

function coverageLabel(ratio: number): string {
  if (!isFinite(ratio)) return "∞";
  return ratio >= 100 ? `${Math.round(ratio)}` : ratio.toFixed(2);
}

/** Sarraf desk: live book, yardstick P&L, and the paymaster gas tank. */
export default function DeskPage() {
  const t = useTranslations("desk");
  const tCommon = useTranslations("common");
  const { isConnected } = useAccount();
  const { sarraf, book, health } = useSarrafBook();

  const stats = useQuery<NetworkStats>({
    queryKey: ["indexer", "stats"],
    refetchInterval: 10_000,
    retry: 1,
    queryFn: ({ signal }) => indexer.stats(signal),
  });

  // Indexer unreachable — the desk is data-driven, so surface it clearly.
  if (health.isError) {
    return (
      <div className="rounded-lg bg-surface p-2xl text-center shadow-card">
        <p className="text-lg font-medium text-foreground">{t("indexerOffline")}</p>
        <p className="mt-sm text-sm text-muted">{t("indexerOfflineHint")}</p>
      </div>
    );
  }

  if (!isConnected || !sarraf) {
    return (
      <div className="rounded-lg bg-surface p-2xl text-center shadow-card">
        <p className="text-lg font-medium text-foreground">{t("connectPrompt")}</p>
        <p className="mt-sm text-sm text-muted">{tCommon("notConnected")}</p>
      </div>
    );
  }

  if (book.isLoading || !book.data) {
    return <p className="rounded-md bg-surface p-lg text-sm text-muted">{tCommon("loading")}</p>;
  }

  const b = book.data;
  const band = b.certBand;
  const bandTone = band === "certified" ? "success" : band === "at-risk" ? "warning" : "danger";
  const bandLabel =
    band === "certified" ? t("bandCertified") : band === "at-risk" ? t("bandAtRisk") : t("bandBelowFloor");

  return (
    <div className="flex flex-col gap-xl">
      {/* sync status strip */}
      <div className="flex flex-wrap items-center justify-between gap-sm text-xs text-muted">
        <span dir="ltr" className="font-mono">
          {b.sarraf.slice(0, 10)}…{b.sarraf.slice(-4)}
        </span>
        <span>
          {t("syncedBlock")}{" "}
          <span dir="ltr" className="font-medium text-foreground">
            #{health.data?.lastSyncedBlock ?? b.lastEventBlock}
          </span>
        </span>
      </div>

      {/* book KPIs */}
      <section className="grid grid-cols-2 gap-md lg:grid-cols-4">
        <KpiTile label={t("backing")} value={fmt(b.backing)} unit={tCommon("usdt")} />
        <KpiTile label={t("outstanding")} value={fmt(b.outstanding)} unit={tCommon("iou")} />
        <KpiTile
          label={t("coverage")}
          value={coverageLabel(b.coverageRatio)}
          unit="×"
          tone={b.coverageRatio >= 1 ? "success" : "danger"}
          hint={t("coverageHint")}
        />
        <KpiTile
          label={t("feesEarned")}
          value={fmt(b.pnl.feesGenerated)}
          unit={tCommon("usdt")}
          hint={t("feesToFund")}
        />
      </section>

      {/* certification + credit */}
      <section className="rounded-lg bg-surface p-lg shadow-card">
        <div className="mb-md flex items-center justify-between gap-md">
          <h2 className="text-base font-semibold text-foreground">{t("certification")}</h2>
          <div className="flex items-center gap-sm">
            <span
              className={`rounded-pill px-md py-[3px] text-xs font-semibold ${
                b.certifiedOnChain
                  ? "bg-success/15 text-success"
                  : "bg-danger/15 text-danger"
              }`}
            >
              {b.certifiedOnChain ? t("certified") : t("notCertified")}
            </span>
            <span
              className={`rounded-pill px-md py-[3px] text-xs font-medium ${
                bandTone === "success"
                  ? "bg-success/10 text-success"
                  : bandTone === "warning"
                    ? "bg-warning/10 text-warning"
                    : "bg-danger/10 text-danger"
              }`}
            >
              {bandLabel}
            </span>
          </div>
        </div>

        <CoverageMeter
          twab={b.twab}
          floor={b.certificationFloor}
          band={band}
          twabDisplay={`${fmt(b.twab)} ${tCommon("usdt")}`}
          floorDisplay={`${fmt(b.certificationFloor)} ${tCommon("usdt")}`}
          labels={{ floor: t("floor"), exit: t("exitFloor"), twab: t("twab") }}
        />

        <div className="mt-lg flex items-center justify-between rounded-md bg-surface-alt p-md">
          <div>
            <p className="text-xs font-medium text-foreground">{t("creditRate")}</p>
            <p className="text-[10px] text-muted">{t("creditRateDormant")}</p>
          </div>
          <span className="font-heading text-lg font-bold text-muted" dir="ltr">
            {(b.creditRateBps / 100).toFixed(2)}%
          </span>
        </div>
      </section>

      {/* yardstick P&L */}
      <section className="rounded-lg bg-surface p-lg shadow-card">
        <div className="mb-md flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">{t("yardstick")}</h2>
          <span className="text-[10px] text-muted">{t("yardstickTag")}</span>
        </div>
        <div className="grid grid-cols-2 gap-md lg:grid-cols-3">
          <KpiTile label={t("depositVolume")} value={fmt(b.pnl.depositVolume)} unit={tCommon("usdt")} />
          <KpiTile label={t("issuedVolume")} value={fmt(b.pnl.issuedVolume)} unit={tCommon("iou")} />
          <KpiTile label={t("redemptionVolume")} value={fmt(b.pnl.redemptionVolume)} unit={tCommon("iou")} />
          <KpiTile label={t("feesEarned")} value={fmt(b.pnl.feesGenerated)} unit={tCommon("usdt")} />
          <KpiTile label={t("spread")} value={(b.pnl.spreadBps / 100).toFixed(2)} unit="%" />
          <KpiTile
            label={t("claimsPaid")}
            value={stats.data ? fmt(stats.data.claimsPaid) : "…"}
            unit={tCommon("usdt")}
            tone={stats.data && stats.data.claimsPaid !== "0" ? "danger" : "default"}
          />
        </div>
        <div className="mt-md flex flex-wrap gap-lg text-xs text-muted">
          <span>
            {t("feeSplit")}:{" "}
            <span dir="ltr" className="text-foreground">
              {t("maintenance")} {fmt(b.pnl.feeSplit.maintenance)} · {t("overseeing")}{" "}
              {fmt(b.pnl.feeSplit.overseeing)}
            </span>
          </span>
          <span>
            {t("redemptions")}:{" "}
            <span dir="ltr" className="text-foreground">
              {b.pnl.redemptionCount}
            </span>
          </span>
        </div>
      </section>

      {/* members + gas tank */}
      <div className="grid gap-xl lg:grid-cols-2">
        <section className="rounded-lg bg-surface p-lg shadow-card">
          <div className="mb-md flex items-center justify-between">
            <h2 className="text-base font-semibold text-foreground">{t("members")}</h2>
            <span className="rounded-pill bg-surface-alt px-md py-[2px] text-xs font-medium text-foreground">
              {b.memberCount}
            </span>
          </div>
          {b.members.length === 0 ? (
            <p className="text-sm text-muted">{t("noMembers")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {b.members.map((m) => (
                <li key={m} className="py-sm">
                  <span dir="ltr" className="font-mono text-xs text-foreground">
                    {m.slice(0, 12)}…{m.slice(-6)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <GasTank />
      </div>
    </div>
  );
}
