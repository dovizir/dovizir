"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou, parseIou, type Hex } from "@dovizir/sdk";
import { AmountField } from "@/components/amount-field";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { useEscrow, useIouBalance } from "@/lib/hooks";
import { formatFiat } from "@/lib/ramp";

const FIATS = ["IRR", "TRY"] as const;
const WINDOWS = [
  { seconds: 1800, key: "m30" },
  { seconds: 3600, key: "h1" },
  { seconds: 86400, key: "h24" },
] as const;

/** Maker screen: lock IOU of a tranche into escrow as a firm P2P sell offer. */
export default function CreateOrderPage() {
  const t = useTranslations("market.create");
  const tCommon = useTranslations("common");
  const unit = tCommon("unit");
  const router = useRouter();
  const { isConnected } = useAccount();
  const { byTranche } = useIouBalance();
  const { createOrder } = useEscrow();

  const [trancheIdx, setTrancheIdx] = useState(0);
  const [amount, setAmount] = useState("");
  const [fiat, setFiat] = useState<string>("IRR");
  const [fiatAmount, setFiatAmount] = useState("");
  const [windowSec, setWindowSec] = useState<number>(3600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tranche = byTranche[trancheIdx];
  const amountUnits = useMemo(() => {
    try {
      return parseIou(amount);
    } catch {
      return 0n;
    }
  }, [amount]);
  const overBalance = !!tranche && amountUnits > tranche.balance;

  async function submit() {
    setError(null);
    if (!tranche) return setError(t("noTranche"));
    if (amountUnits <= 0n) return setError(t("enterAmount"));
    if (overBalance) return setError(t("overBalance"));
    const fa = Number(fiatAmount);
    if (!Number.isFinite(fa) || fa <= 0) return setError(t("enterFiat"));
    try {
      setBusy(true);
      const id = await createOrder({
        sellerSarraf: tranche.sarraf as Hex,
        usdtAmount: amountUnits,
        fiat,
        fiatAmount: BigInt(Math.round(fa)),
        paymentWindow: windowSec,
      });
      router.push(`/market/${id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-xl">
      <NotDeployedBanner />
      <header>
        <h1 className="text-xl font-medium text-foreground">{t("title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("subtitle", { unit })}</p>
      </header>

      <section className="flex flex-col gap-lg rounded-lg bg-surface p-xl shadow-card">
        <div>
          <label className="text-xs font-medium text-muted">{t("tranche")}</label>
          {byTranche.length === 0 ? (
            <p className="mt-xs text-sm text-muted">{t("noTranche")}</p>
          ) : (
            <select
              value={trancheIdx}
              onChange={(e) => setTrancheIdx(Number(e.target.value))}
              className="mt-xs w-full rounded-md border border-border bg-background px-md py-sm text-sm"
              dir="ltr"
            >
              {byTranche.map((tr, i) => (
                <option key={tr.sarraf} value={i}>
                  {tr.sarraf.slice(0, 10)}… — {formatIou(tr.balance)} {unit}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="text-xs font-medium text-muted">{t("amount")}</label>
          <AmountField value={amount} onChange={setAmount} id="create-amount" />
          {overBalance && <p className="mt-xs text-xs text-danger">{t("overBalance")}</p>}
        </div>

        <div className="flex gap-md">
          <div className="w-1/3">
            <label className="text-xs font-medium text-muted">{t("fiat")}</label>
            <select
              value={fiat}
              onChange={(e) => setFiat(e.target.value)}
              className="mt-xs w-full rounded-md border border-border bg-background px-md py-sm text-sm"
              dir="ltr"
            >
              {FIATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="text-xs font-medium text-muted">{t("fiatAmount", { fiat })}</label>
            <input
              inputMode="numeric"
              value={fiatAmount}
              onChange={(e) => setFiatAmount(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="0"
              dir="ltr"
              className="mt-xs w-full rounded-md border border-border bg-background px-md py-sm text-sm"
            />
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-muted">{t("window")}</label>
          <div className="mt-xs flex gap-xs">
            {WINDOWS.map((w) => (
              <button
                key={w.seconds}
                type="button"
                onClick={() => setWindowSec(w.seconds)}
                className={`flex-1 rounded-md border px-md py-sm text-xs font-medium ${
                  windowSec === w.seconds
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted"
                }`}
              >
                {t(`windowOpt.${w.key}`)}
              </button>
            ))}
          </div>
        </div>

        {fiatAmount && amountUnits > 0n && (
          <p className="text-xs text-muted">
            {t("priceHint", {
              fiat: formatFiat(Math.round(Number(fiatAmount) / (Number(amountUnits) / 1e6))),
              fiatCode: fiat,
              unit,
            })}
          </p>
        )}

        <button
          type="button"
          disabled={!isConnected || busy || byTranche.length === 0}
          onClick={submit}
          className="w-full rounded-pill bg-primary py-md text-sm font-bold text-primary-foreground disabled:opacity-50"
        >
          {busy ? t("locking") : t("lockAndPost")}
        </button>
        <p className="text-center text-xs text-muted">{t("lockNote")}</p>
      </section>

      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
