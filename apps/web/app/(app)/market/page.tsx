"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou } from "@dovizir/sdk";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { formatFiat } from "@/lib/ramp";
import { p2p, type P2pOrderRecord } from "@/lib/p2p";
import { P2pStatusPill, pricePerUnit } from "./_parts";

/** Consumer P2P marketplace: browse open sell-IOU offers + track my orders. */
export default function MarketPage() {
  const t = useTranslations("market");
  const tCommon = useTranslations("common");
  const unit = tCommon("unit");
  const { address } = useAccount();
  const me = address?.toLowerCase();

  const open = useQuery({
    queryKey: ["p2p", "open"],
    refetchInterval: 4000,
    queryFn: () => p2p.listOrders({ open: true }),
  });
  const mine = useQuery({
    queryKey: ["p2p", "mine", me],
    enabled: !!me,
    refetchInterval: 4000,
    queryFn: async () => {
      const [asMaker, asTaker] = await Promise.all([
        p2p.listOrders({ maker: me! }),
        p2p.listOrders({ taker: me! }),
      ]);
      const byId = new Map<string, P2pOrderRecord>();
      for (const o of [...asMaker.orders, ...asTaker.orders]) byId.set(o.orderId, o);
      return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
    },
  });

  const offers = (open.data?.orders ?? []).filter((o) => o.maker.toLowerCase() !== me);

  return (
    <div className="flex flex-col gap-xl">
      <NotDeployedBanner />
      <header className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-xl font-medium text-foreground">{t("title")}</h1>
          <p className="mt-xs text-sm text-muted">{t("subtitle", { unit })}</p>
        </div>
        <Link
          href="/market/create"
          className="shrink-0 rounded-pill bg-primary px-lg py-sm text-sm font-bold text-primary-foreground"
        >
          {t("sell")}
        </Link>
      </header>

      <section>
        <h2 className="mb-sm text-sm font-semibold text-foreground">{t("openOffers")}</h2>
        {offers.length === 0 ? (
          <p className="rounded-md bg-surface p-lg text-sm text-muted">{t("noOffers")}</p>
        ) : (
          <ul className="flex flex-col gap-md">
            {offers.map((o) => (
              <li key={o.orderId}>
                <Link
                  href={`/market/${o.orderId}`}
                  className="block rounded-lg bg-surface p-lg shadow-card"
                >
                  <OfferRow order={o} unit={unit} takeLabel={t("take")} perUnit={t("perUnit", { fiat: o.fiat })} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {me && (mine.data?.length ?? 0) > 0 && (
        <section>
          <h2 className="mb-sm text-sm font-semibold text-foreground">{t("myOrders")}</h2>
          <ul className="flex flex-col gap-md">
            {mine.data!.map((o) => (
              <li key={o.orderId}>
                <Link
                  href={`/market/${o.orderId}`}
                  className="flex items-center justify-between rounded-lg bg-surface p-lg shadow-card"
                >
                  <div>
                    <p dir="ltr" className="text-sm font-semibold text-foreground">
                      {formatIou(BigInt(o.usdtAmount))} {unit}
                    </p>
                    <p dir="ltr" className="text-xs text-muted">
                      {formatFiat(o.fiatAmount)} {o.fiat} · #{o.orderId} ·{" "}
                      {o.maker.toLowerCase() === me ? t("roleMaker") : t("roleTaker")}
                    </p>
                  </div>
                  <P2pStatusPill status={o.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function OfferRow({
  order,
  unit,
  takeLabel,
  perUnit,
}: {
  order: P2pOrderRecord;
  unit: string;
  takeLabel: string;
  perUnit: string;
}) {
  return (
    <div className="flex items-center justify-between gap-md">
      <div>
        <p dir="ltr" className="text-base font-semibold text-foreground">
          {formatIou(BigInt(order.usdtAmount))} {unit}
        </p>
        <p dir="ltr" className="mt-xs text-xs text-muted">
          {formatFiat(order.fiatAmount)} {order.fiat} · {formatFiat(pricePerUnit(order))} {perUnit}
        </p>
      </div>
      <span className="rounded-pill bg-primary/10 px-md py-[3px] text-xs font-bold text-primary">
        {takeLabel}
      </span>
    </div>
  );
}
