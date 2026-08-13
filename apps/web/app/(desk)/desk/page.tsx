import { useTranslations } from "next-intl";

/** Sarraf desk placeholder — backing/issuance dashboard lands in M3. */
export default function DeskPage() {
  const t = useTranslations("desk");

  return (
    <div className="rounded-lg bg-surface p-2xl text-center shadow-card">
      <p className="text-lg font-medium text-foreground">{t("subtitle")}</p>
      <p className="mt-sm text-sm text-muted">{t("comingSoon")}</p>
    </div>
  );
}
