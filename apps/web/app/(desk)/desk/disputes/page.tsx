"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou } from "@dovizir/sdk";
import { useEscrow } from "@/lib/hooks";
import { formatFiat } from "@/lib/ramp";
import { p2p, type P2pOrderRecord } from "@/lib/p2p";
import { P2pStatusPill, pricePerUnit } from "../../../(app)/market/_parts";

/** Sarraf desk: disputes for tranches this Sarraf issued → resolve to a party. */
export default function DisputesPage() {
  const t = useTranslations("deskDisputes");
  const { address } = useAccount();

  const disputes = useQuery({
    queryKey: ["p2p", "disputes", address],
    enabled: !!address,
    refetchInterval: 4000,
    queryFn: () => p2p.listOrders({ arbiter: address!, status: "DISPUTED" }),
  });
  const list = disputes.data?.orders ?? [];

  return (
    <div className="flex max-w-3xl flex-col gap-xl">
      <header>
        <h1 className="font-heading text-lg font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("subtitle")}</p>
        <p className="mt-sm rounded-md bg-primary/5 p-md text-xs text-muted">{t("skinInGame")}</p>
      </header>

      {list.length === 0 ? (
        <p className="rounded-md bg-surface p-lg text-sm text-muted">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-md">
          {list.map((o) => (
            <DisputeRow key={o.orderId} order={o} onResolved={() => disputes.refetch()} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DisputeRow({ order, onResolved }: { order: P2pOrderRecord; onResolved: () => void }) {
  const t = useTranslations("deskDisputes");
  const tCommon = useTranslations("common");
  const unit = tCommon("unit");
  const { address } = useAccount();
  const escrow = useEscrow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["p2p", "order", order.orderId, address],
    refetchInterval: 4000,
    queryFn: () => p2p.getOrder(order.orderId, address),
  });
  const o = detail.data?.order ?? order;
  const notes = detail.data?.notes ?? [];

  async function resolve(toTaker: boolean) {
    setError(null);
    try {
      setBusy(true);
      await escrow.resolve(o.orderId, toTaker);
      await detail.refetch();
      onResolved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg bg-surface p-lg shadow-card">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">#{o.orderId}</p>
        <P2pStatusPill status={o.status} />
      </div>

      <dl className="mt-md grid grid-cols-2 gap-x-lg gap-y-xs text-sm">
        <Cell label={t("amount")} value={`${formatIou(BigInt(o.usdtAmount))} ${unit}`} />
        <Cell label={t("agreedPrice")} value={`${formatFiat(o.fiatAmount)} ${o.fiat}`} />
        <Cell label={t("perUnit")} value={`${formatFiat(pricePerUnit(o))} ${o.fiat}`} />
        <Cell label={t("raisedBy")} value={o.disputeBy ? `${o.disputeBy.slice(0, 10)}…` : "—"} mono />
        <Cell label={t("maker")} value={`${o.maker.slice(0, 10)}…`} mono />
        <Cell label={t("taker")} value={o.taker ? `${o.taker.slice(0, 10)}…` : "—"} mono />
      </dl>

      <div className="mt-md flex items-center gap-md">
        {o.receiptId ? (
          <a
            href={p2p.receiptUrl(o.receiptId, address!)}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-primary underline"
          >
            {t("viewReceipt")}
          </a>
        ) : (
          <span className="text-xs text-muted">{t("noReceipt")}</span>
        )}
        <span className="text-xs text-muted" dir="ltr">
          quote {o.quoteHash.slice(0, 10)}…
        </span>
      </div>

      {notes.length > 0 && (
        <div className="mt-md rounded-md bg-surface-alt p-md">
          <p className="mb-xs text-xs font-medium text-muted">{t("timeline")}</p>
          <ul className="flex flex-col gap-xs">
            {notes.map((n) => (
              <li key={n.id} className="text-xs">
                <span dir="ltr" className="font-medium text-muted">
                  {n.author.slice(0, 8)}…
                </span>
                <span className="ms-sm text-foreground">{n.body}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {o.status === "DISPUTED" ? (
        <div className="mt-lg flex gap-md">
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve(true)}
            className="flex-1 rounded-pill bg-primary py-sm text-sm font-bold text-primary-foreground disabled:opacity-50"
          >
            {t("resolveTaker")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve(false)}
            className="flex-1 rounded-pill border border-primary py-sm text-sm font-bold text-primary disabled:opacity-50"
          >
            {t("resolveMaker")}
          </button>
        </div>
      ) : (
        <p className="mt-md text-sm text-muted">
          {t("resolved", { side: o.resolvedTo === "taker" ? t("sideTaker") : t("sideMaker") })}
        </p>
      )}

      {error && <p className="mt-sm text-sm text-danger">{error}</p>}
    </li>
  );
}

function Cell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd dir={mono ? "ltr" : undefined} className="font-medium text-foreground">
        {value}
      </dd>
    </div>
  );
}
