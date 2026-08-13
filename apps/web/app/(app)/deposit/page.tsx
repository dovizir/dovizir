"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { parseIou } from "@dovizir/sdk";
import { AmountField } from "@/components/amount-field";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { useAddresses, useDeposit, useSarraf } from "@/lib/hooks";

/**
 * Deposit: the consumer asks THEIR sarraf to take funds and issue IOU.
 * The request itself is an off-chain stub for M2 (the indexer/desk inbox
 * carries it later); the direct on-chain path (approve + ReservePool.deposit)
 * is exposed below for sarraf-side backing.
 */
export default function DepositPage() {
  const t = useTranslations("deposit");
  const tCommon = useTranslations("common");
  const { isConnected } = useAccount();
  const { deployed } = useAddresses();
  const { sarraf, isLoading: sarrafLoading } = useSarraf();
  const { deposit, step } = useDeposit();

  const [amount, setAmount] = useState("");
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDirectDeposit() {
    setError(null);
    try {
      await deposit(parseIou(amount));
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

      <section className="rounded-lg bg-surface p-xl shadow-card">
        <p className="text-sm font-medium text-muted">{t("yourSarraf")}</p>
        {sarrafLoading ? (
          <p className="mt-sm text-sm text-muted">{tCommon("loading")}</p>
        ) : sarraf ? (
          <p className="mt-sm text-sm font-medium text-foreground" dir="ltr">
            {sarraf}
          </p>
        ) : (
          <p className="mt-sm text-sm text-muted">{t("noSarraf")}</p>
        )}

        <div className="mt-lg flex flex-col gap-lg">
          <AmountField value={amount} onChange={setAmount} id="request-amount" />
          {requested ? (
            <p className="rounded-md bg-success/10 p-md text-sm text-success">
              {t("requested")}
            </p>
          ) : (
            <button
              type="button"
              disabled={!isConnected || !sarraf || !amount}
              onClick={() => setRequested(true)}
              className="rounded-pill bg-primary py-md text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              {t("request")}
            </button>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-border p-xl">
        <h2 className="text-sm font-medium text-foreground">
          {t("howItWorksTitle")}
        </h2>
        <p className="mt-sm text-sm text-muted">{t("howItWorks")}</p>
      </section>

      <section className="rounded-lg border border-border p-xl">
        <h2 className="text-sm font-medium text-foreground">{t("onchainTitle")}</h2>
        <p className="mt-sm text-sm text-muted">{t("onchainHint")}</p>
        {error && <p className="mt-sm text-sm text-danger">{error}</p>}
        <button
          type="button"
          disabled={!deployed || !isConnected || !amount || step !== "idle"}
          onClick={onDirectDeposit}
          className="mt-lg rounded-pill border border-primary px-xl py-sm text-sm font-bold text-primary disabled:opacity-50"
        >
          {step === "idle" ? t("approveAndDeposit") : tCommon("submitted")}
        </button>
      </section>
    </div>
  );
}
