import { useTranslations } from "next-intl";

/** Seller terminal placeholder — charge/scan-to-pay flows land in M3. */
export default function PosPage() {
  const t = useTranslations("pos");

  return (
    <div className="rounded-lg bg-surface p-2xl text-center shadow-card">
      <p className="text-lg font-medium text-foreground">{t("subtitle")}</p>
      <p className="mt-sm text-sm text-muted">{t("comingSoon")}</p>
    </div>
  );
}
