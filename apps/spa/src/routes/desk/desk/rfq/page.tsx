"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou, type Hex } from "@dovizir/sdk";
import { useRampSign } from "@/lib/hooks";
import { formatFiat, indicativeFiat, ramp, type RfqRecord } from "@/lib/ramp";

/** Sarraf desk: incoming RFQs → sign & send a firm quote (indicative pre-fills). */
export default function DeskRfqPage() {
  const t = useTranslations("deskRamp.rfq");
  const { address } = useAccount();

  const rfqs = useQuery({
    queryKey: ["ramp", "rfqs", address],
    enabled: !!address,
    refetchInterval: 4000,
    queryFn: () => ramp.listRfqs({ sarraf: address! }),
  });

  const list = rfqs.data?.rfqs ?? [];
  const pending = list.filter((r) => r.status === "pending");
  const quoted = list.filter((r) => r.status === "quoted");

  return (
    <div className="flex max-w-[48rem] flex-col gap-xl">
      <header>
        <h1 className="font-heading text-lg font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("subtitle")}</p>
      </header>

      {pending.length === 0 && quoted.length === 0 ? (
        <p className="rounded-md bg-surface p-lg text-sm text-muted">{t("empty")}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-md">
            {pending.map((r) => (
              <RfqRow key={r.id} rfq={r} onQuoted={() => rfqs.refetch()} />
            ))}
          </ul>
          {quoted.length > 0 && (
            <section>
              <h2 className="mb-sm text-sm font-medium text-muted">{t("quoted")}</h2>
              <ul className="flex flex-col gap-sm">
                {quoted.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between rounded-md bg-surface p-md text-sm shadow-sm"
                  >
                    <span dir="ltr" className="font-mono text-xs text-muted">
                      {r.customer.slice(0, 10)}…
                    </span>
                    <span className="text-muted">{r.direction}</span>
                    <span dir="ltr" className="font-medium text-foreground">
                      {r.usdtAmount ? formatIou(BigInt(r.usdtAmount)) : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function RfqRow({ rfq, onQuoted }: { rfq: RfqRecord; onQuoted: () => void }) {
  const t = useTranslations("deskRamp.rfq");
  const tDir = useTranslations("ramp.direction");
  const tCommon = useTranslations("common");
  const { address } = useAccount();
  const { signFirmQuote } = useRampSign();
  const unit = tCommon("unit");

  const rate = useQuery({
    queryKey: ["ramp", "rate", rfq.sarraf, rfq.fiat],
    retry: 0,
    queryFn: () => ramp.getRate(rfq.sarraf, rfq.fiat).catch(() => null),
  });

  // Indicative suggestion: on-ramp uses the sell rate, off-ramp the buy rate.
  const usdtBase = rfq.usdtAmount ? BigInt(rfq.usdtAmount) : 0n;
  const boardRate = rate.data
    ? rfq.direction === "on-ramp"
      ? rate.data.sellRate
      : rate.data.buyRate
    : null;
  const suggested = boardRate ? indicativeFiat(usdtBase, boardRate) : null;

  const [fiatAmount, setFiatAmount] = useState("");
  const [ttl, setTtl] = useState("180");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveFiat = fiatAmount || (suggested !== null ? String(suggested) : "");

  async function send() {
    setError(null);
    if (!address) return;
    try {
      setBusy(true);
      const nonce = Math.floor(Date.now() / 1000);
      const signed = await signFirmQuote({
        sarraf: address as Hex,
        customer: rfq.customer as Hex,
        direction: rfq.direction,
        usdtAmount: rfq.usdtAmount ?? "0",
        fiatAmount: effectiveFiat,
        ttlSeconds: Number(ttl) || 180,
        nonce,
      });
      await ramp.answerRfq(rfq.id, signed);
      setSent(true);
      onQuoted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg bg-surface p-lg shadow-card">
      <div className="mb-md flex flex-wrap items-center justify-between gap-sm text-sm">
        <span dir="ltr" className="font-mono text-xs text-muted">
          {t("customer")}: {rfq.customer.slice(0, 10)}…
        </span>
        <span className="rounded-pill bg-surface-alt px-md py-[2px] text-xs font-medium text-foreground">
          {rfq.direction === "on-ramp" ? tDir("onRamp") : tDir("offRamp")} · {rfq.fiat}
        </span>
      </div>

      <div className="mb-md text-sm">
        <span className="text-muted">{t("wants")}: </span>
        <span dir="ltr" className="font-bold text-foreground">
          {rfq.usdtAmount ? `${formatIou(BigInt(rfq.usdtAmount))} ${unit}` : rfq.fiatAmount}
        </span>
      </div>

      {rate.data === null ? (
        <p className="text-xs text-warning">{t("noRate")}</p>
      ) : (
        suggested !== null && (
          <p className="mb-sm text-xs text-muted">
            {t("suggested")}:{" "}
            <span dir="ltr" className="text-foreground">
              {formatFiat(suggested)} {rfq.fiat}
            </span>
          </p>
        )
      )}

      <div className="flex flex-wrap items-end gap-md">
        <label className="block">
          <span className="mb-xs block text-xs font-medium text-muted">
            {t("yourFiat")} ({rfq.fiat})
          </span>
          <input
            dir="ltr"
            inputMode="numeric"
            value={fiatAmount}
            placeholder={suggested !== null ? String(suggested) : ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || /^\d*$/.test(v)) setFiatAmount(v);
            }}
            className="w-40 rounded-md border border-border bg-surface-alt px-md py-sm text-sm text-foreground outline-none focus:border-focus"
          />
        </label>
        <label className="block">
          <span className="mb-xs block text-xs font-medium text-muted">{t("ttl")}</span>
          <input
            dir="ltr"
            inputMode="numeric"
            value={ttl}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || /^\d*$/.test(v)) setTtl(v);
            }}
            className="w-24 rounded-md border border-border bg-surface-alt px-md py-sm text-sm text-foreground outline-none focus:border-focus"
          />
        </label>
        <button
          type="button"
          disabled={busy || sent || !effectiveFiat}
          onClick={send}
          className="rounded-pill bg-primary px-xl py-sm text-sm font-bold text-primary-foreground disabled:opacity-50"
        >
          {busy ? t("sending") : sent ? t("sent", { ttl }) : t("sendQuote")}
        </button>
      </div>
      {error && <p className="mt-sm text-sm text-danger">{error}</p>}
    </li>
  );
}
