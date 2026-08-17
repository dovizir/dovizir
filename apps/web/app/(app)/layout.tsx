import { useTranslations } from "next-intl";
import { BottomNav } from "@/components/bottom-nav";
import { ConnectButton } from "@/components/connect-button";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { PersonaSwitcher } from "@/components/persona-switcher";
import { JoinCapture } from "@/components/join-capture";

/** Consumer shell: wordmark header, content column, bottom navigation. */
export default function ConsumerLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const t = useTranslations("common");

  return (
    <div className="min-h-dvh pb-2xl">
      <JoinCapture />
      <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-[28rem] items-center justify-between gap-md px-lg py-md">
          <span className="font-heading text-base font-extrabold text-primary">
            {t("appName")}
          </span>
          <div className="flex items-center gap-sm">
            <PersonaSwitcher />
            <LocaleSwitcher />
            <ConnectButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[28rem] px-lg py-xl pb-[96px]">{children}</main>
      <BottomNav />
    </div>
  );
}
