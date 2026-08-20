"use client";

import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou, type Hex } from "@dovizir/sdk";
import { UnitMark } from "@/components/unit-mark";
import { usePayShop } from "@/lib/hooks/use-pay-shop";

const isAddress = (v: string | null): v is Hex => !!v && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * The customer's half of a QR purchase. Opened from the seller's QR, so the
 * shop and amount arrive in the link — the customer only reviews and taps Pay.
 * After paying, one more tap confirms receipt at the counter, which closes the
 * coverage window and finalises the sale for the seller.
 */
export default function PayPage() {
  const t = useTranslations("pay");
  const [params] = useSearchParams();
  const { isConnected } = useAccount();
  const { payShop, confirmReceipt, isPending } = usePayShop();

  const shop = params.get("shop");
  const amountRaw = params.get("amount");
  const amount = (() => {
    try {
      return amountRaw ? BigInt(amountRaw) : 0n;
    } catch {
      return 0n;
    }
  })();

  const [stage, setStage] = useState<"review" | "paid" | "confirmed">("review");
  const [purchaseId, setPurchaseId] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isAddress(shop) || amount <= 0n) {
    return (
      <section className="rounded-lg bg-surface p-xl text-center shadow-card">
        <p className="text-foreground">{t("badLink")}</p>
        <Link className="mt-md inline-block text-sm text-primary" to="/">
          {t("home")}
        </Link>
      </section>
    );
  }

  async function onPay() {
    setError(null);
    try {
      const res = await payShop(shop as Hex, amount);
      setPurchaseId(res.purchaseId);
      setStage("paid");
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "error");
    }
  }

  async function onConfirm() {
    if (purchaseId === null) return;
    setError(null);
    try {
      await confirmReceipt(purchaseId);
      setStage("confirmed");
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "error");
    }
  }

  return (
    <section className="rounded-lg bg-surface p-xl shadow-card">
      <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>

      <dl className="mt-lg flex flex-col gap-sm text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">{t("shop")}</dt>
          <dd className="font-mono text-xs text-foreground" dir="ltr">
            {shop.slice(0, 10)}…{shop.slice(-6)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">{t("amount")}</dt>
          <dd className="font-medium text-foreground" dir="ltr">
            {formatIou(amount)} <UnitMark />
          </dd>
        </div>
      </dl>

      <p className="mt-md text-xs text-muted">{t("coveredNote")}</p>

      {stage === "review" && (
        <button
          type="button"
          onClick={onPay}
          disabled={!isConnected || isPending}
          className="mt-lg w-full rounded-pill bg-primary px-lg py-md font-medium text-primary-foreground disabled:opacity-50"
        >
          {isPending ? "…" : t("payNow")}
        </button>
      )}

      {stage === "paid" && (
        <div className="mt-lg flex flex-col gap-md">
          <p className="rounded-md bg-surface-alt p-md text-sm text-foreground">{t("paidNote")}</p>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending || purchaseId === null}
            className="w-full rounded-pill bg-accent px-lg py-md font-medium text-primary-foreground disabled:opacity-50"
          >
            {isPending ? "…" : t("confirmNow")}
          </button>
        </div>
      )}

      {stage === "confirmed" && (
        <p className="mt-lg rounded-md bg-surface-alt p-md text-sm text-foreground">
          {t("confirmedNote")}
        </p>
      )}

      {!isConnected && <p className="mt-md text-sm text-danger">{t("connectFirst")}</p>}
      {error && <p className="mt-md break-all text-xs text-danger">{error}</p>}
    </section>
  );
}
