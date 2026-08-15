"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou, parseIou, type Hex } from "@dovizir/sdk";
import { AmountField } from "@/components/amount-field";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { useSend } from "@/lib/hooks";
import {
  formatFiat,
  indicativeFiat,
  ramp,
  type IndicativeRateRecord,
  type OrderRecord,
} from "@/lib/ramp";

function CashOutInner() {
  const t = useTranslations("ramp.cashOut");
  const tc = useTranslations("ramp.common");
  const tStatus = useTranslations("ramp.status");
  const tCommon = useTranslations("common");
  const params = useSearchParams();
  const { address, isConnected } = useAccount();
  const { sendDirect } = useSend();
  const unit = tCommon("unit");

  const sarraf = params.get("sarraf") ?? "";
  const fiat = params.get("fiat") ?? "IRR";

  const [amount, setAmount] = useState("");
  const [bank, setBank] = useState("");
  const [rfqId, setRfqId] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rate = useQuery<IndicativeRateRecord | null>({
    queryKey: ["ramp", "rate", sarraf, fiat],
    enabled: !!sarraf,
    retry: 0,
    queryFn: () => ramp.getRate(sarraf, fiat).catch(() => null),
  });

  const rfq = useQuery({
    queryKey: ["ramp", "rfq", rfqId],
    enabled: !!rfqId && !orderId,
    refetchInterval: 2500,
    queryFn: () => ramp.getRfq(rfqId!),
  });

  const order = useQuery<{ order: OrderRecord }>({
    queryKey: ["ramp", "order", orderId],
    enabled: !!orderId,
    refetchInterval: 2500,
    queryFn: () => ramp.getOrder(orderId!),
  });

  const quote = rfq.data?.quote;
  const o = order.data?.order;

  async function requestQuote() {
    setError(null);
    if (!address) return setError(tc("connectFirst"));
    try {
      setBusy(true);
      const usdtAmount = parseIou(amount).toString();
      const created = await ramp.createRfq({
        sarraf,
        customer: address,
        direction: "off-ramp",
        fiat,
        usdtAmount,
      });
      setRfqId(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!quote) return;
    setError(null);
    try {
      setBusy(true);
      const created = await ramp.acceptQuote(quote.quoteId, bank);
      setOrderId(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendIou() {
    if (!o || !address) return;
    setError(null);
    try {
      setBusy(true);
      const txHash = await sendDirect(o.sarraf as Hex, BigInt(o.usdtAmount));
      await ramp.reportIouSent(o.id, { as: address, txHash });
      await order.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const suggested =
    rate.data && amount ? indicativeFiat(parseIouSafe(amount), rate.data.buyRate) : null;

  return (
    <div className="flex flex-col gap-xl">
      <NotDeployedBanner />
      <header>
        <h1 className="text-xl font-medium text-foreground">{t("title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("subtitle", { unit })}</p>
      </header>

      {!sarraf ? (
        <p className="rounded-md bg-surface p-lg text-sm text-muted">{tc("noSarrafRate")}</p>
      ) : !orderId ? (
        <section className="rounded-lg bg-surface p-xl shadow-card">
          <p className="mb-sm text-xs text-muted" dir="ltr">
            {tc("chooseCorridor")}: {fiat} · {sarraf.slice(0, 10)}…
          </p>
          <AmountField value={amount} onChange={setAmount} id="cashout-amount" />
          {suggested !== null && (
            <p className="mt-sm text-xs text-muted">
              {t("indicativeQuote", { fiat: formatFiat(suggested), fiatCode: fiat })}
            </p>
          )}

          <label className="mt-lg block text-sm font-medium text-muted" htmlFor="cashout-bank">
            {t("yourBank")}
          </label>
          <p className="text-xs text-muted">{t("yourBankHint")}</p>
          <textarea
            id="cashout-bank"
            dir="ltr"
            rows={2}
            value={bank}
            onChange={(e) => setBank(e.target.value)}
            placeholder={t("yourBankPlaceholder")}
            className="mt-xs w-full rounded-md border border-border bg-surface-alt p-md text-sm text-foreground outline-none focus:border-focus"
          />

          {!quote ? (
            <button
              type="button"
              disabled={!isConnected || !amount || !bank || busy || !!rfqId}
              onClick={requestQuote}
              className="mt-lg w-full rounded-pill bg-primary py-md text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              {rfqId ? tc("requesting") : busy ? tc("requesting") : t("requestQuote")}
            </button>
          ) : (
            <div className="mt-lg rounded-md border border-primary/40 bg-primary/5 p-lg">
              <p className="text-sm font-semibold text-primary">{t("firmQuote")}</p>
              <div className="mt-sm flex items-center justify-between text-sm">
                <span className="text-muted">{t("youSend")}</span>
                <span dir="ltr" className="font-bold text-foreground">
                  {formatIou(BigInt(quote.usdtAmount))} {unit}
                </span>
              </div>
              <div className="mt-xs flex items-center justify-between text-sm">
                <span className="text-muted">{t("youReceive")}</span>
                <span dir="ltr" className="font-bold text-foreground">
                  {formatFiat(quote.fiatAmount)} {fiat}
                </span>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={accept}
                className="mt-md w-full rounded-pill bg-primary py-md text-sm font-bold text-primary-foreground disabled:opacity-50"
              >
                {t("accept")}
              </button>
            </div>
          )}
        </section>
      ) : (
        <section className="rounded-lg bg-surface p-xl shadow-card">
          <div className="mb-md flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">{t("title")}</p>
            <span className="rounded-pill bg-surface-alt px-md py-[2px] text-xs font-medium text-foreground">
              {o ? tStatus(o.status) : "…"}
            </span>
          </div>

          {o?.status === "SETTLED" ? (
            <p className="rounded-md bg-success/10 p-lg text-sm text-success">{t("settled")}</p>
          ) : o?.status === "IOU_SENT" ? (
            <p className="rounded-md bg-primary/5 p-lg text-sm text-muted">{t("iouSent")}</p>
          ) : (
            <>
              <div className="mb-md flex items-center justify-between text-sm">
                <span className="text-muted">{t("youSend")}</span>
                <span dir="ltr" className="font-bold text-foreground">
                  {o ? formatIou(BigInt(o.usdtAmount)) : "…"} {unit}
                </span>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={sendIou}
                className="w-full rounded-pill bg-primary py-md text-sm font-bold text-primary-foreground disabled:opacity-50"
              >
                {t("sendIou", { unit })}
              </button>
            </>
          )}
        </section>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

function parseIouSafe(v: string): bigint {
  try {
    return parseIou(v);
  } catch {
    return 0n;
  }
}

export default function CashOutPage() {
  return (
    <Suspense>
      <CashOutInner />
    </Suspense>
  );
}
