"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { P2pOrderRecord, P2pStatus } from "@/lib/p2p";

/** Fiat price per 1 unit implied by the order's agreed amounts. */
export function pricePerUnit(o: { usdtAmount: string; fiatAmount: string }): number {
  const units = Number(o.usdtAmount) / 1e6;
  if (units <= 0) return 0;
  return Math.round(Number(o.fiatAmount) / units);
}

const TONE: Record<P2pStatus, string> = {
  OPEN: "bg-primary/10 text-primary",
  MATCHED: "bg-primary/10 text-primary",
  FIAT_CLAIMED: "bg-warning/15 text-warning",
  SETTLED: "bg-success/15 text-success",
  REFUNDED: "bg-surface-alt text-muted",
  DISPUTED: "bg-danger/15 text-danger",
  RESOLVED_TAKER: "bg-success/15 text-success",
  RESOLVED_MAKER: "bg-surface-alt text-muted",
};

/** Status badge shared by the marketplace, escrow flow, and dispute console. */
export function P2pStatusPill({ status }: { status: P2pStatus }) {
  const t = useTranslations("market.status");
  return (
    <span className={`rounded-pill px-md py-[2px] text-xs font-medium ${TONE[status]}`}>
      {t(status)}
    </span>
  );
}

function useNowSec(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Live mm:ss countdown to a unix deadline (US#5 pattern). */
export function Countdown({ deadline, label }: { deadline?: number; label: string }) {
  const t = useTranslations("market");
  const now = useNowSec();
  if (!deadline) return null;
  const left = deadline - now;
  const expired = left <= 0;
  const mm = Math.floor(Math.abs(left) / 60);
  const ss = Math.abs(left) % 60;
  return (
    <p className={`text-xs ${expired ? "text-danger" : "text-muted"}`}>
      {label}{" "}
      <span dir="ltr" className="font-medium">
        {expired ? t("elapsed") : `${mm}:${String(ss).padStart(2, "0")}`}
      </span>
    </p>
  );
}

export type { P2pOrderRecord };
