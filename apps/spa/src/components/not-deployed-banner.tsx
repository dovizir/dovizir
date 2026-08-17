"use client";

import { useTranslations } from "next-intl";
import { useAddresses } from "@/lib/hooks";

/** Shown while contract addresses are still 0x0 (pre-deployment). */
export function NotDeployedBanner() {
  const t = useTranslations("common.notDeployed");
  const { deployed } = useAddresses();

  if (deployed) return null;

  return (
    <div
      role="status"
      className="rounded-md border border-warning/40 bg-warning/10 p-lg text-sm"
    >
      <p className="font-medium text-foreground">{t("title")}</p>
      <p className="mt-xs text-muted">{t("body")}</p>
    </div>
  );
}
