"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import type { Hex } from "@dovizir/sdk";
import { useRampSign } from "@/lib/hooks";
import { formatFiat, ramp, type IndicativeRateRecord } from "@/lib/ramp";

const CORRIDORS = ["IRR", "TRY"] as const;

/** Sarraf desk: set/update the signed indicative buy/sell rate per corridor. */
export default function DeskRatesPage() {
  const t = useTranslations("deskRamp.rates");
  const tCommon = useTranslations("common");
  const { address, isConnected } = useAccount();
  const { signIndicativeRate } = useRampSign();
  const unit = tCommon("unit");

  const [fiat, setFiat] = useState<(typeof CORRIDORS)[number]>("IRR");
  const [buyRate, setBuyRate] = useState("");
  const [sellRate, setSellRate] = useState("");
  const [minUsdt, setMinUsdt] = useState("10");
  const [maxUsdt, setMaxUsdt] = useState("50000");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = useQuery<IndicativeRateRecord | null>({
    queryKey: ["ramp", "rate", address, fiat],
    enabled: !!address,
    refetchInterval: 8000,
    retry: 0,
    queryFn: () => ramp.getRate(address!, fiat).catch(() => null),
  });

  async function publish() {
    setError(null);
    setDone(false);
    if (!address) return;
    try {
      setBusy(true);
      const nonce = Math.floor(Date.now() / 1000);
      const signed = await signIndicativeRate({
        sarraf: address as Hex,
        fiat,
        buyRate,
        sellRate,
        minUsdt,
        maxUsdt,
        nonce,
      });
      await ramp.postRate(signed);
      setDone(true);
      await current.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const c = current.data;

  return (
    <div className="flex max-w-2xl flex-col gap-xl">
      <header>
        <h1 className="font-heading text-lg font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("subtitle")}</p>
      </header>

      {/* corridor picker */}
      <div className="flex gap-sm">
        {CORRIDORS.map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => setFiat(code)}
            className={`rounded-pill px-lg py-sm text-sm font-medium ${
              fiat === code ? "bg-primary text-primary-foreground" : "bg-surface text-muted"
            }`}
          >
            {code}
          </button>
        ))}
      </div>

      {/* current record */}
      <section className="rounded-lg bg-surface p-lg shadow-card">
        <p className="text-xs font-medium text-muted">{t("current")}</p>
        {c ? (
          <div className="mt-sm grid grid-cols-2 gap-md text-sm">
            <div>
              <span className="text-muted">{t("buyRate", { unit })}: </span>
              <span dir="ltr" className="font-bold text-foreground">
                {formatFiat(c.buyRate)}
              </span>
            </div>
            <div>
              <span className="text-muted">{t("sellRate", { unit })}: </span>
              <span dir="ltr" className="font-bold text-foreground">
                {formatFiat(c.sellRate)}
              </span>
            </div>
            <div className="col-span-2 text-xs text-muted" dir="ltr">
              {c.minUsdt}–{c.maxUsdt} {unit}
            </div>
          </div>
        ) : (
          <p className="mt-sm text-sm text-muted">{t("none")}</p>
        )}
      </section>

      {/* setter */}
      <section className="rounded-lg bg-surface p-lg shadow-card">
        <div className="grid grid-cols-2 gap-md">
          <Field label={t("buyRate", { unit })} value={buyRate} onChange={setBuyRate} />
          <Field label={t("sellRate", { unit })} value={sellRate} onChange={setSellRate} />
          <Field label={t("minUsdt", { unit })} value={minUsdt} onChange={setMinUsdt} />
          <Field label={t("maxUsdt", { unit })} value={maxUsdt} onChange={setMaxUsdt} />
        </div>
        <p className="mt-md text-xs text-muted">{t("signHint")}</p>
        <button
          type="button"
          disabled={!isConnected || !buyRate || !sellRate || busy}
          onClick={publish}
          className="mt-md rounded-pill bg-primary px-xl py-sm text-sm font-bold text-primary-foreground disabled:opacity-50"
        >
          {busy ? t("publishing") : t("sign")}
        </button>
        {done && <p className="mt-sm text-sm text-success">{t("published", { fiat })}</p>}
        {error && <p className="mt-sm text-sm text-danger">{error}</p>}
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-xs block text-xs font-medium text-muted">{label}</span>
      <input
        dir="ltr"
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "" || /^\d*$/.test(v)) onChange(v);
        }}
        className="w-full rounded-md border border-border bg-surface-alt px-md py-sm text-sm text-foreground outline-none focus:border-focus"
      />
    </label>
  );
}
