"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { formatIou } from "@dovizir/sdk";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { AirplaneToggle } from "@/components/notes/airplane-toggle";
import { useAirplane } from "@/lib/notes/airplane";
import { isLocalChain, reconcileOnChain } from "@/lib/notes/chain";
import { submitPending } from "@/lib/notes/indexer";
import { addressForPubkey, shortHex } from "@/lib/notes/personas";
import { listReceived, updateReceived, type ReceivedTranscript } from "@/lib/notes/store";

export default function ReconcilePage() {
  const t = useTranslations("notes");
  const { airplane } = useAirplane();
  const [items, setItems] = useState<ReceivedTranscript[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refresh = async () =>
    setItems((await listReceived()).sort((a, b) => b.receivedAt - a.receivedAt));
  useEffect(() => {
    void refresh();
  }, []);

  async function fastCheck(r: ReceivedTranscript) {
    setBusy(r.key);
    try {
      await submitPending(r.transcript.serial, r.transcript);
      await updateReceived(r.key, { status: "submitted" });
      await refresh();
    } catch (e) {
      setErrors((p) => ({ ...p, [r.key]: e instanceof Error ? e.message : "error" }));
    } finally {
      setBusy(null);
    }
  }

  async function settle(r: ReceivedTranscript) {
    setBusy(r.key);
    setErrors((p) => ({ ...p, [r.key]: "" }));
    try {
      const recipient = addressForPubkey(r.transcript.invoice.recipient);
      if (!recipient) throw new Error("unknown recipient persona");
      const res = await reconcileOnChain({
        root: r.onchainRoot,
        serial: r.transcript.serial,
        proof: r.proof,
        recipient,
        amount: r.transcript.value,
        nonce: r.transcript.invoice.nonce,
        expiry: r.transcript.expiry,
      });
      await updateReceived(r.key, {
        status: res.outcome === "convicted" ? "convicted" : "settled",
        txHash: res.hash,
      });
      await refresh();
    } catch (e) {
      setErrors((p) => ({ ...p, [r.key]: e instanceof Error ? e.message : "error" }));
    } finally {
      setBusy(null);
    }
  }

  const badge = (s: ReceivedTranscript["status"]) => {
    const map: Record<string, string> = {
      pending: "bg-warning/15 text-warning",
      submitted: "bg-primary/10 text-primary",
      settled: "bg-success/15 text-success",
      convicted: "bg-danger/15 text-danger",
    };
    return map[s] ?? "bg-border text-muted";
  };

  return (
    <div className="flex flex-col gap-xl">
      <NotDeployedBanner />
      <header>
        <h1 className="text-xl font-medium text-foreground">{t("reconcile.title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("reconcile.subtitle")}</p>
      </header>

      <AirplaneToggle />
      {airplane && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-md text-sm text-foreground">
          {t("reconcile.offlineBlocked")}
        </p>
      )}

      <section className="flex flex-col gap-md">
        {items.length === 0 && <p className="text-sm text-muted">{t("reconcile.empty")}</p>}
        {items.map((r) => (
          <div key={r.key} className="rounded-lg bg-surface p-lg shadow-card">
            <div className="flex items-center justify-between">
              <span className="text-base font-bold text-foreground" dir="ltr">
                {formatIou(r.transcript.value)} IOU
              </span>
              <span className={`rounded-pill px-md py-xs text-xs font-bold ${badge(r.status)}`}>
                {t(`reconcile.status.${r.status}`)}
              </span>
            </div>
            <p className="mt-xs text-xs text-muted" dir="ltr">
              {r.note} · {shortHex(r.transcript.serial, 10, 6)}
            </p>
            {r.txHash && (
              <p className="mt-xs break-all text-[10px] text-muted" dir="ltr">
                {r.txHash}
              </p>
            )}

            {r.status === "convicted" && (
              <p className="mt-md rounded-md bg-danger/10 p-md text-xs text-danger">
                {t("reconcile.convictedNote")}
              </p>
            )}

            {(r.status === "pending" || r.status === "submitted") && (
              <div className="mt-md flex flex-wrap gap-sm">
                <button
                  type="button"
                  disabled={airplane || busy === r.key}
                  onClick={() => fastCheck(r)}
                  className="rounded-pill border border-primary px-lg py-sm text-xs font-bold text-primary disabled:opacity-40"
                >
                  {t("reconcile.fastCheck")}
                </button>
                <button
                  type="button"
                  disabled={airplane || busy === r.key || !isLocalChain()}
                  onClick={() => settle(r)}
                  className="rounded-pill bg-primary px-lg py-sm text-xs font-bold text-primary-foreground disabled:opacity-40"
                >
                  {busy === r.key ? "…" : t("reconcile.settle")}
                </button>
              </div>
            )}
            {errors[r.key] && (
              <p className="mt-sm break-all text-xs text-danger">{errors[r.key]}</p>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
