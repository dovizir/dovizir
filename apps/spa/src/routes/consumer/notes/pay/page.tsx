"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { spendNote, type Invoice } from "@dovizir/notes";
import type { SpendBundle } from "@/lib/notes/codec";
import { formatIou } from "@dovizir/sdk";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { AirplaneToggle } from "@/components/notes/airplane-toggle";
import { QrCode } from "@/components/notes/qr-code";
import { QrScanInput } from "@/components/notes/qr-scan-input";
import { isInvoicePayload, packSpend, unpackInvoice } from "@/lib/notes/codec";
import { solRootAndProof } from "@/lib/notes/bridge";
import { publishHandoff } from "@/lib/notes/handoff";
import { CARVER, personaForPubkey, shortHex } from "@/lib/notes/personas";
import {
  listBatches,
  commitSpendAtomic,
  spendKey,
  type StoredBatch,
} from "@/lib/notes/store";

export default function PayPage() {
  const t = useTranslations("notes");
  const [batches, setBatches] = useState<StoredBatch[]>([]);
  const [raw, setRaw] = useState("");
  const [bundle, setBundle] = useState<SpendBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => setBatches(await listBatches());
  useEffect(() => {
    void refresh();
  }, []);

  const invoice = useMemo<Invoice | null>(() => {
    if (!raw.trim()) return null;
    try {
      if (!isInvoicePayload(raw)) return null;
      return unpackInvoice(raw);
    } catch {
      return null;
    }
  }, [raw]);

  // Notes whose face value matches the invoice amount (value must equal amount).
  const candidates = useMemo(() => {
    if (!invoice) return [];
    const out: { batch: StoredBatch; index: number; serial: string; value: bigint }[] = [];
    for (const b of batches) {
      b.batch.notes.forEach((n, index) => {
        if (!b.spentSerials.includes(n.serial) && n.value === invoice.amount) {
          out.push({ batch: b, index, serial: n.serial, value: n.value });
        }
      });
    }
    return out;
  }, [batches, invoice]);

  async function pay(c: { batch: StoredBatch; index: number; serial: string }) {
    if (!invoice) return;
    setError(null);
    try {
      // Pure offline: produces a signed Transcript with NO network access.
      const tx = spendNote({
        batch: c.batch.batch,
        noteIndex: c.index,
        invoice,
        carver: CARVER.offline,
      });
      const serials = c.batch.batch.notes.map((n) => n.serial);
      const { proof } = solRootAndProof(serials, c.index);
      const spendBundle: SpendBundle = { t: tx, r: c.batch.onchainRoot, p: proof };
      // One transaction: the serial is marked AND the spend recorded, or
      // neither is. A crash between two separate writes could leave the note
      // looking spendable after it was handed over — a double spend the chain
      // punishes by seizing collateral, for what was only a flat battery.
      await commitSpendAtomic(c.batch.batchRoot, tx.serial, {
        key: spendKey(tx.serial, invoice.nonce),
        transcript: tx,
        onchainRoot: c.batch.onchainRoot,
        proof,
        createdAt: Math.floor(Date.now() / 1000),
      });
      // Only now may the recipient receive it.
      publishHandoff(packSpend(spendBundle));
      setBundle(spendBundle);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    }
  }

  const recipient = invoice ? personaForPubkey(invoice.recipient) : undefined;

  return (
    <div className="flex flex-col gap-xl">
      <NotDeployedBanner />
      <header>
        <h1 className="text-xl font-medium text-foreground">{t("pay.title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("pay.subtitle")}</p>
      </header>

      <AirplaneToggle />

      {bundle ? (
        <section className="flex flex-col items-center gap-md rounded-lg bg-surface p-xl shadow-card">
          <p className="text-sm font-medium text-foreground">{t("pay.showToSeller")}</p>
          <QrCode value={packSpend(bundle)} />
          <p className="text-center text-xs text-muted" dir="ltr">
            {formatIou(bundle.t.value)} → {shortHex(bundle.t.invoice.recipient)}
          </p>
          <p className="rounded-md bg-success/10 p-md text-center text-xs text-success">
            {t("pay.doneOffline")}
          </p>
          <button
            type="button"
            onClick={() => {
              setBundle(null);
              setRaw("");
            }}
            className="rounded-pill border border-primary px-xl py-sm text-sm font-bold text-primary"
          >
            {t("pay.payAnother")}
          </button>
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-md rounded-lg bg-surface p-xl shadow-card">
            <label className="text-sm font-medium text-muted">{t("pay.scanInvoice")}</label>
            <QrScanInput value={raw} onChange={setRaw} placeholder="dvz:inv:…" />
            {raw.trim() && !invoice && (
              <p className="text-xs text-danger">{t("pay.badInvoice")}</p>
            )}
            {invoice && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-md text-sm">
                <p className="font-medium text-foreground" dir="ltr">
                  {formatIou(invoice.amount)} IOU
                  {recipient ? ` → ${recipient.id}` : ""}
                </p>
                {invoice.memo && <p className="text-xs text-muted">“{invoice.memo}”</p>}
                <p className="mt-xs break-all text-[10px] text-muted" dir="ltr">
                  {shortHex(invoice.recipient, 12, 6)}
                </p>
              </div>
            )}
          </section>

          {invoice && (
            <section className="flex flex-col gap-sm">
              <h2 className="text-sm font-bold text-foreground">{t("pay.pickNote")}</h2>
              {candidates.length === 0 && (
                <p className="text-sm text-muted">{t("pay.noMatch")}</p>
              )}
              {candidates.map((c) => (
                <button
                  key={c.serial}
                  type="button"
                  onClick={() => pay(c)}
                  className="flex items-center justify-between rounded-md border border-border bg-surface p-md text-start"
                >
                  <span className="text-sm font-medium text-foreground" dir="ltr">
                    {formatIou(c.value)} IOU
                  </span>
                  <span className="text-xs text-muted" dir="ltr">
                    {shortHex(c.serial, 8, 4)}
                  </span>
                </button>
              ))}
              {error && <p className="break-all text-sm text-danger">{error}</p>}
            </section>
          )}
        </>
      )}
    </div>
  );
}
