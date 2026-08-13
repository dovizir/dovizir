"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { AirplaneToggle } from "@/components/notes/airplane-toggle";

const flows = [
  { href: "/notes/carve", key: "carve", icon: "✂️" },
  { href: "/notes/pay", key: "pay", icon: "📤" },
  { href: "/notes/receive", key: "receive", icon: "📥" },
  { href: "/notes/reconcile", key: "reconcile", icon: "🔗" },
] as const;

/** Offline-cash hub: explains the model and routes into each flow + the demo. */
export default function NotesHubPage() {
  const t = useTranslations("notes");

  return (
    <div className="flex flex-col gap-xl">
      <NotDeployedBanner />

      <header>
        <h1 className="text-xl font-medium text-foreground">{t("hub.title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("hub.subtitle")}</p>
      </header>

      <AirplaneToggle />

      <Link
        href="/notes/demo"
        className="flex items-center justify-between gap-md rounded-lg bg-primary p-xl text-primary-foreground shadow-card"
      >
        <span>
          <span className="block text-base font-bold">{t("hub.demoTitle")}</span>
          <span className="mt-xs block text-sm opacity-90">{t("hub.demoHint")}</span>
        </span>
        <span aria-hidden className="text-2xl">
          ▶
        </span>
      </Link>

      <section className="grid grid-cols-2 gap-md">
        {flows.map((f) => (
          <Link
            key={f.href}
            href={f.href}
            className="flex flex-col gap-sm rounded-lg bg-surface p-lg shadow-card"
          >
            <span aria-hidden className="text-2xl leading-none">
              {f.icon}
            </span>
            <span className="text-sm font-medium text-foreground">{t(`hub.${f.key}`)}</span>
            <span className="text-xs text-muted">{t(`hub.${f.key}Hint`)}</span>
          </Link>
        ))}
      </section>

      <section className="rounded-lg border border-border bg-surface-alt p-lg">
        <h2 className="text-sm font-bold text-foreground">{t("hub.howTitle")}</h2>
        <p className="mt-xs text-xs text-muted">{t("hub.how")}</p>
      </section>
    </div>
  );
}
