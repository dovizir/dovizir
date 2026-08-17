"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { carveBatch, type Hex } from "@dovizir/notes";
import { formatIou, parseIou } from "@dovizir/sdk";
import { AmountField } from "@/components/amount-field";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { ExpiryCountdown } from "@/components/notes/expiry-countdown";
import { carveOnChain, isCarverReady, isLocalChain, readVaultState } from "@/lib/notes/chain";
import { solRootAndProof } from "@/lib/notes/bridge";
import { splitDenominations } from "@/lib/notes/denominations";
import { CARVER, shortHex, TRANCHE_ID } from "@/lib/notes/personas";
import { listBatches, putBatch, type StoredBatch } from "@/lib/notes/store";

export default function CarvePage() {
  const t = useTranslations("notes");
  const tc = useTranslations("common");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [batches, setBatches] = useState<StoredBatch[]>([]);
  const [vault, setVault] = useState<{ locked: bigint; cap: bigint } | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);

  const refresh = async () => {
    setBatches((await listBatches()).sort((a, b) => b.createdAt - a.createdAt));
    try {
      const v = await readVaultState();
      setVault({ locked: v.locked, cap: v.cap });
      const r = await isCarverReady();
      setReady(r.ready);
    } catch {
      setReady(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const parsed = (() => {
    try {
      return amount ? parseIou(amount) : 0n;
    } catch {
      return 0n;
    }
  })();

  const capLeft = vault ? vault.cap - vault.locked : 0n;
  const canCarve =
    isLocalChain() && ready === true && parsed > 0n && parsed <= capLeft && status !== "busy";

  async function onCarve() {
    setError(null);
    setStatus("busy");
    try {
      const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
      const denominations = splitDenominations(parsed);
      const batch = carveBatch({
        carver: CARVER.offline,
        trancheId: `0x${TRANCHE_ID.toString(16)}` as Hex,
        denominations,
        expiry,
      });
      const serials = batch.notes.map((n) => n.serial);
      const { root: onchainRoot } = solRootAndProof(serials, 0);
      const txHash = await carveOnChain(onchainRoot, parsed, expiry);
      const stored: StoredBatch = {
        batchRoot: batch.batchRoot,
        onchainRoot,
        batch,
        amount: parsed,
        expiry,
        carveTxHash: txHash,
        spentSerials: [],
        createdAt: Math.floor(Date.now() / 1000),
      };
      await putBatch(stored);
      setStatus("done");
      setAmount("");
      await refresh();
    } catch (e) {
      setStatus("idle");
      setError(e instanceof Error ? e.message : tc("error"));
    }
  }

  return (
    <div className="flex flex-col gap-xl">
      <NotDeployedBanner />
      <header>
        <h1 className="text-xl font-medium text-foreground">{t("carve.title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("carve.subtitle")}</p>
      </header>

      {isLocalChain() && ready === false && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-lg text-sm">
          <p className="font-medium text-foreground">{t("carve.notReady")}</p>
          <p className="mt-xs text-muted">{t("carve.notReadyHint")}</p>
        </div>
      )}

      <section className="flex flex-col gap-lg rounded-lg bg-surface p-xl shadow-card">
        <AmountField value={amount} onChange={setAmount} id="carve-amount" />
        {vault && (
          <p className="text-xs text-muted" dir="ltr">
            {t("carve.capLeft", { amount: formatIou(capLeft) })}
          </p>
        )}
        {parsed > 0n && (
          <p className="text-xs text-muted">
            {t("carve.willSplit", { count: splitDenominations(parsed).length })}
          </p>
        )}
        {error && <p className="break-all text-sm text-danger">{error}</p>}
        {status === "done" && (
          <p className="rounded-md bg-success/10 p-md text-sm text-success">{t("carve.done")}</p>
        )}
        <button
          type="button"
          disabled={!canCarve}
          onClick={onCarve}
          className="rounded-pill bg-primary py-md text-sm font-bold text-primary-foreground disabled:opacity-50"
        >
          {status === "busy" ? tc("loading") : t("carve.cta")}
        </button>
      </section>

      <section className="flex flex-col gap-md">
        <h2 className="text-sm font-bold text-foreground">{t("carve.yourCash")}</h2>
        {batches.length === 0 && <p className="text-sm text-muted">{t("carve.empty")}</p>}
        {batches.map((b) => {
          const spendable = b.batch.notes.filter((n) => !b.spentSerials.includes(n.serial));
          const spendableValue = spendable.reduce((s, n) => s + n.value, 0n);
          return (
            <div key={b.batchRoot} className="rounded-lg bg-surface p-lg shadow-card">
              <div className="flex items-baseline justify-between">
                <span className="text-lg font-bold text-foreground" dir="ltr">
                  {formatIou(spendableValue)} {tc("iou")}
                </span>
                <span className="text-xs text-muted">
                  <ExpiryCountdown expiry={b.expiry} />
                </span>
              </div>
              <p className="mt-xs text-xs text-muted">
                {t("carve.notesCount", {
                  spendable: spendable.length,
                  total: b.batch.notes.length,
                })}
              </p>
              <div className="mt-md flex flex-wrap gap-xs">
                {b.batch.notes.slice(0, 8).map((n) => {
                  const spent = b.spentSerials.includes(n.serial);
                  return (
                    <span
                      key={n.serial}
                      title={n.serial}
                      className={`rounded-pill px-md py-xs text-[10px] font-medium ${
                        spent
                          ? "bg-border/60 text-muted line-through"
                          : "bg-primary/10 text-primary"
                      }`}
                      dir="ltr"
                    >
                      {formatIou(n.value)} · {shortHex(n.serial, 6, 3)}
                    </span>
                  );
                })}
              </div>
              <p className="mt-md rounded-md bg-success/10 p-sm text-[11px] text-success">
                {t("carve.offlineNote")}
              </p>
            </div>
          );
        })}
      </section>

      <div className="flex gap-md text-sm">
        <Link href="/notes/pay" className="font-medium text-primary">
          {t("carve.goPay")} →
        </Link>
      </div>
    </div>
  );
}
