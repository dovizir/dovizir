import { useTranslations } from "next-intl";
import { ConnectButton } from "@/components/connect-button";
import { LocaleSwitcher } from "@/components/locale-switcher";

/** Sarraf desk shell: desktop-first dashboard chrome with a side rail. */
export default function DeskLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const t = useTranslations("desk");
  const tCommon = useTranslations("common");

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-64 shrink-0 border-e border-border bg-surface p-xl md:block">
        <span className="font-heading text-base font-extrabold text-primary">
          {tCommon("appName")}
        </span>
        <p className="mt-sm text-sm text-muted">{t("subtitle")}</p>
      </aside>
      <div className="flex-1">
        <header className="border-b border-border">
          <div className="flex items-center justify-between gap-md px-xl py-lg">
            <h1 className="font-heading text-xl font-semibold text-foreground">
              {t("title")}
            </h1>
            <div className="flex items-center gap-sm">
              <LocaleSwitcher />
              <ConnectButton />
            </div>
          </div>
        </header>
        <main className="px-xl py-xl">{children}</main>
      </div>
    </div>
  );
}
