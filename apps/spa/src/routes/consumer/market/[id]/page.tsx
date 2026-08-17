"use client";

import { useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou } from "@dovizir/sdk";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { useEscrow } from "@/lib/hooks";
import { fileToBase64, formatFiat } from "@/lib/ramp";
import { p2p } from "@/lib/p2p";
import { Countdown, P2pStatusPill, pricePerUnit } from "../_parts";

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  return <OrderInner id={id ?? ""} />;
}

function OrderInner({ id }: { id: string }) {
  const t = useTranslations("market");
  const tc = useTranslations("common");
  const unit = tc("unit");
  const { address } = useAccount();
  const me = address?.toLowerCase();
  const escrow = useEscrow();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bank, setBank] = useState("");
  const [note, setNote] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const detail = useQuery({
    queryKey: ["p2p", "order", id, me],
    refetchInterval: 3000,
    queryFn: () => p2p.getOrder(id, address),
  });
  const o = detail.data?.order;
  const notes = detail.data?.notes ?? [];

  if (!o) {
    return (
      <div className="flex flex-col gap-lg">
        <NotDeployedBanner />
        <p className="rounded-md bg-surface p-lg text-sm text-muted">{t("loading")}</p>
      </div>
    );
  }

  const isMaker = !!me && me === o.maker.toLowerCase();
  const isTaker = !!me && !!o.taker && me === o.taker.toLowerCase();
  const canTake = o.status === "OPEN" && !isMaker;
  const pastPayment = !!o.paymentDeadline && Math.floor(Date.now() / 1000) > o.paymentDeadline;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      setBusy(true);
      await fn();
      await detail.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadAndClaim(file: File) {
    if (!address) return;
    await run(async () => {
      const dataBase64 = await fileToBase64(file);
      const res = await p2p.uploadReceipt(id, { as: address, mime: file.type, dataBase64 });
      await escrow.claimFiatPaid(id, res.receipt.hash as `0x${string}`);
    });
  }

  const btn = "w-full rounded-pill py-md text-sm font-bold disabled:opacity-50";
  const primary = `${btn} bg-primary text-primary-foreground`;
  const outline = `${btn} border border-danger text-danger`;

  return (
    <div className="flex flex-col gap-lg">
      <NotDeployedBanner />

      <header className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-xl font-medium text-foreground">
            {t("orderTitle", { id })}
          </h1>
          <p dir="ltr" className="mt-xs text-sm text-muted">
            {formatIou(BigInt(o.usdtAmount))} {unit} · {formatFiat(o.fiatAmount)} {o.fiat}
          </p>
        </div>
        <P2pStatusPill status={o.status} />
      </header>

      {/* Terms */}
      <section className="flex flex-col gap-sm rounded-lg bg-surface p-lg shadow-card">
        <Row label={t("youGetOrPay")} value={`${formatFiat(pricePerUnit(o))} ${t("perUnit", { fiat: o.fiat })}`} />
        <Row label={t("role")} value={isMaker ? t("roleMaker") : isTaker ? t("roleTaker") : t("roleVisitor")} />
        <Row label={t("arbiter")} value={`${o.arbiter.slice(0, 10)}…`} mono />
        {o.status === "MATCHED" && (
          <Countdown deadline={o.paymentDeadline} label={t("payWithin")} />
        )}
        {o.status === "FIAT_CLAIMED" && (
          <Countdown deadline={o.confirmDeadline} label={t("confirmWithin")} />
        )}
      </section>

      {/* Bank details exchange */}
      {(o.status === "MATCHED" || o.status === "FIAT_CLAIMED") && (
        <section className="rounded-lg bg-surface p-lg shadow-card">
          <p className="text-xs font-medium text-muted">{t("bankDetails")}</p>
          {o.makerBank ? (
            <p dir="ltr" className="mt-xs whitespace-pre-wrap text-sm text-foreground">
              {o.makerBank}
            </p>
          ) : isMaker ? (
            <div className="mt-xs flex gap-xs">
              <input
                value={bank}
                onChange={(e) => setBank(e.target.value)}
                placeholder={t("bankPlaceholder")}
                className="flex-1 rounded-md border border-border bg-background px-md py-sm text-sm"
              />
              <button
                type="button"
                disabled={busy || !bank}
                onClick={() => run(() => p2p.setBank(id, { as: address!, makerBank: bank }))}
                className="rounded-pill bg-primary px-lg text-sm font-bold text-primary-foreground disabled:opacity-50"
              >
                {t("share")}
              </button>
            </div>
          ) : (
            <p className="mt-xs text-sm text-muted">{t("bankPending")}</p>
          )}
        </section>
      )}

      {/* Actions */}
      <section className="flex flex-col gap-sm">
        {canTake && (
          <button type="button" disabled={busy} onClick={() => run(() => escrow.fillOrder(id))} className={primary}>
            {t("take")}
          </button>
        )}

        {isMaker && o.status === "OPEN" && (
          <button type="button" disabled={busy} onClick={() => run(() => escrow.cancel(id))} className={outline}>
            {t("cancel")}
          </button>
        )}

        {isTaker && o.status === "MATCHED" && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadAndClaim(f);
              }}
            />
            <button
              type="button"
              disabled={busy || !o.makerBank}
              onClick={() => fileInput.current?.click()}
              className={primary}
            >
              {t("payAndUpload")}
            </button>
            {!o.makerBank && <p className="text-center text-xs text-muted">{t("waitBank")}</p>}
          </>
        )}

        {isMaker && o.status === "MATCHED" && pastPayment && (
          <button type="button" disabled={busy} onClick={() => run(() => escrow.cancel(id))} className={outline}>
            {t("cancelTimeout")}
          </button>
        )}

        {isMaker && o.status === "FIAT_CLAIMED" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => escrow.confirmReceived(id))}
            className={primary}
          >
            {t("confirm")}
          </button>
        )}

        {(isMaker || isTaker) && o.status === "FIAT_CLAIMED" && (
          <button type="button" disabled={busy} onClick={() => run(() => escrow.raiseDispute(id))} className={outline}>
            {t("dispute")}
          </button>
        )}

        {o.receiptId && (isMaker || isTaker) && (
          <a
            href={p2p.receiptUrl(o.receiptId, address!)}
            target="_blank"
            rel="noreferrer"
            className="text-center text-xs font-medium text-primary underline"
          >
            {t("viewReceipt")}
          </a>
        )}
      </section>

      {/* Outcome banners */}
      {(o.status === "SETTLED" || o.status === "RESOLVED_TAKER") && (
        <p className="rounded-md bg-success/10 p-lg text-sm text-success">{t("outcomeTaker", { unit })}</p>
      )}
      {(o.status === "REFUNDED" || o.status === "RESOLVED_MAKER") && (
        <p className="rounded-md bg-surface-alt p-lg text-sm text-muted">{t("outcomeMaker", { unit })}</p>
      )}
      {o.status === "DISPUTED" && (
        <p className="rounded-md bg-danger/10 p-lg text-sm text-danger">{t("outcomeDisputed")}</p>
      )}

      {/* Chat / notes (US#5) */}
      {(isMaker || isTaker) && (
        <section className="rounded-lg bg-surface p-lg shadow-card">
          <p className="mb-sm text-xs font-medium text-muted">{t("chat")}</p>
          <ul className="flex flex-col gap-xs">
            {notes.length === 0 && <li className="text-xs text-muted">{t("noMessages")}</li>}
            {notes.map((n) => (
              <li key={n.id} className="text-sm">
                <span dir="ltr" className="text-xs font-medium text-muted">
                  {n.author.slice(0, 8)}…
                </span>
                <span className="ms-sm text-foreground">{n.body}</span>
              </li>
            ))}
          </ul>
          <div className="mt-sm flex gap-xs">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("messagePlaceholder")}
              className="flex-1 rounded-md border border-border bg-background px-md py-sm text-sm"
            />
            <button
              type="button"
              disabled={busy || !note}
              onClick={() =>
                run(async () => {
                  await p2p.addNote(id, { as: address!, body: note });
                  setNote("");
                })
              }
              className="rounded-pill bg-primary px-lg text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              {t("send")}
            </button>
          </div>
        </section>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted">{label}</span>
      <span dir={mono ? "ltr" : undefined} className="font-medium text-foreground">
        {value}
      </span>
    </div>
  );
}
