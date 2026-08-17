"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  createInvoice,
  verifyTranscript,
  type Invoice,
  type Transcript,
  type VerifyResult,
} from "@dovizir/notes";
import { formatIou, parseIou } from "@dovizir/sdk";
import { AmountField } from "@/components/amount-field";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { AirplaneToggle } from "@/components/notes/airplane-toggle";
import { QrCode } from "@/components/notes/qr-code";
import { QrScanInput } from "@/components/notes/qr-scan-input";
import { isTranscriptPayload, packInvoice, unpackSpend } from "@/lib/notes/codec";
import type { SpendBundle } from "@/lib/notes/codec";
import { publishHandoff } from "@/lib/notes/handoff";
import {
  CERTS,
  ROOT_PUBLIC_KEY,
  SELLERS,
  shortHex,
  type Persona,
} from "@/lib/notes/personas";
import { putReceived, spendKey } from "@/lib/notes/store";

export default function ReceivePage() {
  const t = useTranslations("notes");
  const [seller, setSeller] = useState<Persona>(SELLERS[0]!);
  const [amount, setAmount] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [raw, setRaw] = useState("");
  const [result, setResult] = useState<{ verify: VerifyResult; tx: Transcript } | null>(null);

  const parsed = (() => {
    try {
      return amount ? parseIou(amount) : 0n;
    } catch {
      return 0n;
    }
  })();

  function makeInvoice() {
    const inv = createInvoice({ recipient: seller.offline, amount: parsed, memo: `${seller.id} sale` });
    setInvoice(inv);
    setResult(null);
    setRaw("");
    publishHandoff(packInvoice(inv));
  }

  const incoming = useMemo<SpendBundle | null>(() => {
    if (!raw.trim() || !isTranscriptPayload(raw)) return null;
    try {
      return unpackSpend(raw);
    } catch {
      return null;
    }
  }, [raw]);

  async function verify() {
    if (!incoming) return;
    // Full offline verification as the recipient device runs it.
    const v = verifyTranscript({
      transcript: incoming.t,
      memberCert: CERTS.memberCert,
      sarrafCert: CERTS.sarrafCert,
      rootPublicKey: ROOT_PUBLIC_KEY,
      now: Math.floor(Date.now() / 1000),
      expectedRecipient: seller.offline.publicKey,
    });
    setResult({ verify: v, tx: incoming.t });
    if (v.valid) {
      await putReceived({
        key: spendKey(incoming.t.serial, incoming.t.invoice.nonce),
        transcript: incoming.t,
        onchainRoot: incoming.r,
        proof: incoming.p,
        status: "pending",
        receivedAt: Math.floor(Date.now() / 1000),
        note: seller.id,
      });
    }
  }

  return (
    <div className="flex flex-col gap-xl">
      <NotDeployedBanner />
      <header>
        <h1 className="text-xl font-medium text-foreground">{t("receive.title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("receive.subtitle")}</p>
      </header>

      <AirplaneToggle />

      <section className="flex flex-col gap-md rounded-lg bg-surface p-xl shadow-card">
        <div className="flex gap-sm">
          {SELLERS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSeller(s)}
              className={`flex-1 rounded-md border p-sm text-xs font-medium ${
                seller.id === s.id ? "border-primary bg-primary/5 text-primary" : "border-border text-muted"
              }`}
            >
              {s.id}
            </button>
          ))}
        </div>
        <AmountField value={amount} onChange={setAmount} id="invoice-amount" />
        <button
          type="button"
          disabled={parsed <= 0n}
          onClick={makeInvoice}
          className="rounded-pill bg-primary py-md text-sm font-bold text-primary-foreground disabled:opacity-50"
        >
          {t("receive.createInvoice")}
        </button>
        {invoice && (
          <div className="flex flex-col items-center gap-sm pt-sm">
            <QrCode value={packInvoice(invoice)} />
            <p className="text-xs text-muted" dir="ltr">
              {formatIou(invoice.amount)} → {seller.id}
            </p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-md rounded-lg bg-surface p-xl shadow-card">
        <label className="text-sm font-medium text-muted">{t("receive.scanTranscript")}</label>
        <QrScanInput value={raw} onChange={setRaw} placeholder="dvz:tx:…" />
        <button
          type="button"
          disabled={!incoming}
          onClick={verify}
          className="rounded-pill border border-primary py-md text-sm font-bold text-primary disabled:opacity-50"
        >
          {t("receive.verify")}
        </button>

        {result && (
          <div
            className={`rounded-md p-md text-sm ${
              result.verify.valid
                ? "bg-success/10 text-success"
                : "bg-danger/10 text-danger"
            }`}
          >
            <p className="font-bold">
              {result.verify.valid ? t("receive.accepted") : t("receive.rejected")}
            </p>
            <p className="mt-xs text-xs" dir="ltr">
              {formatIou(result.tx.value)} IOU · {shortHex(result.tx.serial, 8, 4)}
            </p>
            {!result.verify.valid && (
              <p className="mt-xs font-mono text-xs">{result.verify.reason}</p>
            )}
            {result.verify.valid && <p className="mt-xs text-xs">{t("receive.storedPending")}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
