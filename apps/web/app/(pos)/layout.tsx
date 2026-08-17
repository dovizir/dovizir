import { useTranslations } from "next-intl";
import { ConnectButton } from "@/components/connect-button";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { PersonaSwitcher } from "@/components/persona-switcher";

/** Seller (point-of-sale) shell: wide counter-top layout, no bottom nav. */
export default function PosLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const t = useTranslations("pos");

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-[48rem] items-center justify-between gap-md px-xl py-lg">
          <h1 className="font-heading text-xl font-semibold text-foreground">
            {t("title")}
          </h1>
          <div className="flex items-center gap-sm">
            <PersonaSwitcher />
            <LocaleSwitcher />
            <ConnectButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[48rem] px-xl py-xl">{children}</main>
    </div>
  );
}
