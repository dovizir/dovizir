"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou, parseIou } from "@dovizir/sdk";
import { AmountField } from "@/components/amount-field";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import {
  fileToBase64,
  formatFiat,
  indicativeFiat,
  ramp,
  type IndicativeRateRecord,
  type OrderRecord,
} from "@/lib/ramp";

function useNowSec(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function CashInInner() {
  const t = useTranslations("ramp.cashIn");
  const tc = useTranslations("ramp.common");
  const tStatus = useTranslations("ramp.status");
  const tCommon = useTranslations("common");
  const params = useSearchParams();
  const { address, isConnected } = useAccount();
  const unit = tCommon("unit");
  const nowSec = useNowSec();

  const sarraf = params.get("sarraf") ?? "";
  const fiat = params.get("fiat") ?? "IRR";

  const [amount, setAmount] = useState("");
  const [rfqId, setRfqId] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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
  const secondsLeft = quote ? quote.validUntil - nowSec : 0;
  const expired = !!quote && secondsLeft <= 0;
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
        direction: "on-ramp",
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
      const created = await ramp.acceptQuote(quote.quoteId);
      setOrderId(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    if (!o || !address) return;
    setError(null);
    try {
      setBusy(true);
      const dataBase64 = await fileToBase64(file);
      await ramp.uploadReceipt(o.id, { as: address, mime: file.type, dataBase64 });
      await order.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const suggested =
    rate.data && amount ? indicativeFiat(parseIouSafe(amount), rate.data.sellRate) : null;

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
          <AmountField value={amount} onChange={setAmount} id="cashin-amount" />
          {suggested !== null && (
            <p className="mt-sm text-xs text-muted">
              {t("indicativeQuote", { fiat: formatFiat(suggested), fiatCode: fiat })}
            </p>
          )}

          {!quote ? (
            <button
              type="button"
              disabled={!isConnected || !amount || busy || !!rfqId}
              onClick={requestQuote}
              className="mt-lg w-full rounded-pill bg-primary py-md text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              {rfqId ? t("quotePending") : busy ? tc("requesting") : t("requestQuote")}
            </button>
          ) : (
            <div className="mt-lg rounded-md border border-primary/40 bg-primary/5 p-lg">
              <p className="text-sm font-semibold text-primary">{t("firmQuote")}</p>
              <div className="mt-sm flex items-center justify-between text-sm">
                <span className="text-muted">{t("youReceive")}</span>
                <span dir="ltr" className="font-bold text-foreground">
                  {formatIou(BigInt(quote.usdtAmount))} {unit}
                </span>
              </div>
              <div className="mt-xs flex items-center justify-between text-sm">
                <span className="text-muted">{t("youPay")}</span>
                <span dir="ltr" className="font-bold text-foreground">
                  {formatFiat(quote.fiatAmount)} {fiat}
                </span>
              </div>
              <p className={`mt-sm text-xs ${expired ? "text-danger" : "text-muted"}`}>
                {expired ? t("expired") : t("validFor", { seconds: Math.max(0, secondsLeft) })}
              </p>
              <button
                type="button"
                disabled={expired || busy}
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
            <p className="text-sm font-semibold text-foreground">{t("payTitle")}</p>
            <span className="rounded-pill bg-surface-alt px-md py-[2px] text-xs font-medium text-foreground">
              {o ? tStatus(o.status) : "…"}
            </span>
          </div>

          {o?.status === "SETTLED" ? (
            <p className="rounded-md bg-success/10 p-lg text-sm text-success">
              {t("settled", { unit })}
            </p>
          ) : o?.status === "FIAT_CLAIMED" ? (
            <p className="rounded-md bg-primary/5 p-lg text-sm text-muted">{t("receiptUploaded")}</p>
          ) : (
            <>
              <p className="text-sm text-muted">{t("payHint")}</p>
              <div className="mt-md rounded-md bg-surface-alt p-md">
                <p className="text-xs font-medium text-muted">{t("bankDetails")}</p>
                {o?.sarrafBank ? (
                  <p dir="ltr" className="mt-xs text-sm text-foreground">
                    {o.sarrafBank}
                  </p>
                ) : (
                  <p className="mt-xs text-sm text-muted">{t("bankPending")}</p>
                )}
              </div>
              <div className="mt-sm flex items-center justify-between text-sm">
                <span className="text-muted">{t("youPay")}</span>
                <span dir="ltr" className="font-bold text-foreground">
                  {o ? formatFiat(o.fiatAmount) : "…"} {fiat}
                </span>
              </div>

              <input
                ref={fileInput}
                type="file"
                accept="image/*,application/pdf"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                }}
              />
              <button
                type="button"
                disabled={busy || !o?.sarrafBank}
                onClick={() => fileInput.current?.click()}
                className="mt-lg w-full rounded-pill bg-primary py-md text-sm font-bold text-primary-foreground disabled:opacity-50"
              >
                {t("uploadReceipt")}
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

export default function CashInPage() {
  return (
    <Suspense>
      <CashInInner />
    </Suspense>
  );
}
