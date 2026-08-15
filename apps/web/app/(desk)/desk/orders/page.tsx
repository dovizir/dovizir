"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou, type Hex } from "@dovizir/sdk";
import { useIssue } from "@/lib/hooks";
import {
  fileToBase64,
  formatFiat,
  ramp,
  type FirmQuoteRecord,
  type OrderRecord,
} from "@/lib/ramp";

/** Sarraf desk: pending on/off-ramp orders → review receipt → confirm/issue. */
export default function DeskOrdersPage() {
  const t = useTranslations("deskRamp.orders");
  const { address } = useAccount();

  const orders = useQuery({
    queryKey: ["ramp", "orders", address],
    enabled: !!address,
    refetchInterval: 4000,
    queryFn: () => ramp.listOrders({ sarraf: address! }),
  });

  const list = orders.data?.orders ?? [];

  return (
    <div className="flex max-w-3xl flex-col gap-xl">
      <header>
        <h1 className="font-heading text-lg font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("subtitle")}</p>
      </header>

      {list.length === 0 ? (
        <p className="rounded-md bg-surface p-lg text-sm text-muted">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-md">
          {list.map((o) => (
            <OrderRow key={o.id} order={o} onChange={() => orders.refetch()} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderRow({ order, onChange }: { order: OrderRecord; onChange: () => void }) {
  const t = useTranslations("deskRamp.orders");
  const tStatus = useTranslations("ramp.status");
  const tDir = useTranslations("ramp.direction");
  const tCommon = useTranslations("common");
  const { address } = useAccount();
  const { issue } = useIssue();
  const unit = tCommon("unit");

  const detail = useQuery<{ order: OrderRecord; quote?: FirmQuoteRecord }>({
    queryKey: ["ramp", "order", order.id],
    refetchInterval: 4000,
    queryFn: () => ramp.getOrder(order.id),
  });
  const o = detail.data?.order ?? order;

  const [bank, setBank] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function shareBank() {
    if (!address || !bank) return;
    setError(null);
    try {
      setBusy(true);
      await ramp.setBank(o.id, { as: address, sarrafBank: bank });
      onChange();
      await detail.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmIssue() {
    if (!address) return;
    setError(null);
    try {
      setBusy(true);
      // On-chain issuance mints backed IOU into the customer's tranche.
      const txHash = await issue(o.customer as Hex, BigInt(o.usdtAmount));
      // The sync loop links the Issued event → SETTLED; this call records intent.
      await ramp.confirmOrder(o.id, { as: address, txHash });
      onChange();
      await detail.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadPayout(file: File) {
    if (!address) return;
    setError(null);
    try {
      setBusy(true);
      const dataBase64 = await fileToBase64(file);
      await ramp.uploadReceipt(o.id, { as: address, mime: file.type, dataBase64 });
      onChange();
      await detail.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!address) return;
    try {
      setBusy(true);
      await ramp.rejectOrder(o.id, address);
      onChange();
      await detail.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const receiptHref =
    o.receiptId && address ? ramp.receiptUrl(o.receiptId, address) : undefined;
  const terminal = o.status === "SETTLED" || o.status === "REJECTED";

  return (
    <li className="rounded-lg bg-surface p-lg shadow-card">
      <div className="mb-md flex flex-wrap items-center justify-between gap-sm">
        <span dir="ltr" className="font-mono text-xs text-muted">
          {t("customer")}: {o.customer.slice(0, 10)}…
        </span>
        <div className="flex items-center gap-sm">
          <span className="rounded-pill bg-surface-alt px-md py-[2px] text-xs font-medium text-foreground">
            {o.direction === "on-ramp" ? tDir("onRamp") : tDir("offRamp")} · {o.fiat}
          </span>
          <span
            className={`rounded-pill px-md py-[2px] text-xs font-semibold ${
              o.status === "SETTLED"
                ? "bg-success/15 text-success"
                : o.status === "REJECTED"
                  ? "bg-danger/15 text-danger"
                  : "bg-primary/10 text-primary"
            }`}
          >
            {tStatus(o.status)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-md text-sm">
        <div>
          <span className="text-muted">{t("amount")}: </span>
          <span dir="ltr" className="font-bold text-foreground">
            {formatIou(BigInt(o.usdtAmount))} {unit}
          </span>
        </div>
        <div>
          <span className="text-muted">{t("fiat")}: </span>
          <span dir="ltr" className="font-bold text-foreground">
            {formatFiat(o.fiatAmount)} {o.fiat}
          </span>
        </div>
      </div>

      {/* receipt evidence */}
      <div className="mt-md rounded-md bg-surface-alt p-md text-xs">
        <span className="font-medium text-muted">{t("receipt")}: </span>
        {receiptHref ? (
          <a
            href={receiptHref}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary underline"
          >
            {t("viewReceipt")}
          </a>
        ) : (
          <span className="text-muted">{t("noReceipt")}</span>
        )}
      </div>

      {o.direction === "off-ramp" && o.customerBank && (
        <div className="mt-sm rounded-md bg-surface-alt p-md text-xs">
          <span className="font-medium text-muted">{t("customerBank")}: </span>
          <span dir="ltr" className="text-foreground">
            {o.customerBank}
          </span>
        </div>
      )}

      {/* actions per state */}
      {!terminal && (
        <div className="mt-md flex flex-col gap-md">
          {/* on-ramp: share bank details while awaiting the customer's receipt */}
          {o.direction === "on-ramp" && o.status === "QUOTED" && (
            <div className="flex flex-wrap items-end gap-sm">
              <label className="flex-1">
                <span className="mb-xs block text-xs font-medium text-muted">{t("setBank")}</span>
                <input
                  dir="ltr"
                  value={bank}
                  placeholder={t("bankPlaceholder")}
                  onChange={(e) => setBank(e.target.value)}
                  className="w-full rounded-md border border-border bg-surface-alt px-md py-sm text-sm text-foreground outline-none focus:border-focus"
                />
              </label>
              <button
                type="button"
                disabled={busy || !bank}
                onClick={shareBank}
                className="rounded-pill border border-primary px-lg py-sm text-sm font-bold text-primary disabled:opacity-50"
              >
                {t("saveBank")}
              </button>
            </div>
          )}

          {o.direction === "on-ramp" && o.status === "QUOTED" && (
            <p className="text-xs text-muted">{t("waitingReceipt")}</p>
          )}

          {/* on-ramp: confirm + issue on-chain */}
          {o.direction === "on-ramp" && o.status === "FIAT_CLAIMED" && (
            <>
              <p className="text-xs text-warning">{t("verifyManual")}</p>
              <button
                type="button"
                disabled={busy}
                onClick={confirmIssue}
                className="rounded-pill bg-primary px-xl py-sm text-sm font-bold text-primary-foreground disabled:opacity-50"
              >
                {busy ? t("issuing") : t("confirmIssue")}
              </button>
            </>
          )}

          {/* off-ramp: wait for IOU, then upload the payout receipt */}
          {o.direction === "off-ramp" && o.status === "QUOTED" && (
            <p className="text-xs text-muted">{t("waitingIou", { unit })}</p>
          )}
          {o.direction === "off-ramp" && o.status === "IOU_SENT" && (
            <>
              <p className="text-xs text-warning">{t("verifyManual")}</p>
              <input
                ref={fileInput}
                type="file"
                accept="image/*,application/pdf"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadPayout(f);
                }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
                className="rounded-pill bg-primary px-xl py-sm text-sm font-bold text-primary-foreground disabled:opacity-50"
              >
                {t("confirmPayOut")}
              </button>
            </>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={reject}
            className="self-start text-xs font-medium text-danger disabled:opacity-50"
          >
            {t("reject")}
          </button>
        </div>
      )}

      {error && <p className="mt-sm text-sm text-danger">{error}</p>}
    </li>
  );
}
