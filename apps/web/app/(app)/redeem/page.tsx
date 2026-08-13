"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou, parseIou } from "@dovizir/sdk";
import { AmountField } from "@/components/amount-field";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { useIouBalance, useRedeem } from "@/lib/hooks";

/** Redeem: burn tranche IOU for USDT, previewing the 0.9% fee split. */
export default function RedeemPage() {
  const t = useTranslations("redeem");
  const tCommon = useTranslations("common");
  const { isConnected } = useAccount();
  const { byTranche } = useIouBalance();
  const { redeem, previewSplit, isPending } = useRedeem();

  const [amount, setAmount] = useState("");
  const [trancheIndex, setTrancheIndex] = useState(0);
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const parsedAmount = (() => {
    try {
      return amount ? parseIou(amount) : 0n;
    } catch {
      return 0n;
    }
  })();
  const split = previewSplit(parsedAmount);
  const tranche = byTranche[trancheIndex];

  async function onRedeem() {
    if (!tranche || parsedAmount === 0n) return;
    setError(null);
    try {
      await redeem(tranche.sarraf, parsedAmount);
      setStatus("done");
      setAmount("");
    } catch {
      setError(tCommon("error"));
    }
  }

  return (
    <div className="flex flex-col gap-xl">
      <NotDeployedBanner />

      <header>
        <h1 className="text-xl font-medium text-foreground">{t("title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("subtitle")}</p>
      </header>

      <section className="flex flex-col gap-lg rounded-lg bg-surface p-xl shadow-card">
        {byTranche.length > 1 && (
          <div>
            <label
              htmlFor="tranche"
              className="mb-xs block text-sm font-medium text-muted"
            >
              {t("fromSarraf")}
            </label>
            <select
              id="tranche"
              value={trancheIndex}
              onChange={(e) => setTrancheIndex(Number(e.target.value))}
              className="w-full rounded-md border border-border bg-surface-alt px-lg py-md text-sm text-foreground"
            >
              {byTranche.map((tr, i) => (
                <option key={tr.sarraf} value={i}>
                  {tr.sarraf.slice(0, 10)}… — {formatIou(tr.balance)}
                </option>
              ))}
            </select>
          </div>
        )}

        <AmountField value={amount} onChange={setAmount} id="redeem-amount" />

        {/* 198.20 / 1.80-style split preview, mirroring on-chain math */}
        <dl className="flex flex-col gap-sm rounded-md bg-surface-alt p-lg text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-muted">{t("youRedeem")}</dt>
            <dd className="font-medium text-foreground" dir="ltr">
              {formatIou(split.gross)} {tCommon("iou")}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted">{t("fee", { feeBps: "0.9%" })}</dt>
            <dd className="font-medium text-danger" dir="ltr">
              −{formatIou(split.fee)} {tCommon("usdt")}
            </dd>
          </div>
          <div className="flex items-center justify-between border-t border-border pt-sm">
            <dt className="font-medium text-foreground">{t("youReceive")}</dt>
            <dd className="font-bold text-success" dir="ltr">
              {formatIou(split.net)} {tCommon("usdt")}
            </dd>
          </div>
        </dl>

        <p className="text-xs text-muted">{t("feeNote", { feeBps: "0.9%" })}</p>
        <p className="text-xs text-muted">{t("exitHint")}</p>

        {error && <p className="text-sm text-danger">{error}</p>}
        {status === "done" && (
          <p className="rounded-md bg-success/10 p-md text-sm text-success">
            {tCommon("submitted")}
          </p>
        )}

        <button
          type="button"
          disabled={!isConnected || !tranche || parsedAmount === 0n || isPending}
          onClick={onRedeem}
          className="rounded-pill bg-primary py-md text-sm font-bold text-primary-foreground disabled:opacity-50"
        >
          {t("redeemNow")}
        </button>
      </section>
    </div>
  );
}
