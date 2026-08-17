"use client";

import { useTranslations } from "next-intl";
import { useAirplane } from "@/lib/notes/airplane";

/** Demo toggle + status banner proving the offline steps need no network. */
export function AirplaneToggle() {
  const t = useTranslations("notes");
  const { airplane, toggle, hydrated } = useAirplane();
  if (!hydrated) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={airplane}
      className={`flex w-full items-center justify-between gap-md rounded-md border p-md text-start transition-colors duration-standard ${
        airplane
          ? "border-warning/50 bg-warning/10"
          : "border-border bg-surface-alt"
      }`}
    >
      <span className="flex items-center gap-sm">
        <span aria-hidden className="text-lg leading-none">
          {airplane ? "✈️" : "📶"}
        </span>
        <span>
          <span className="block text-sm font-medium text-foreground">
            {airplane ? t("airplane.on") : t("airplane.off")}
          </span>
          <span className="block text-xs text-muted">{t("airplane.hint")}</span>
        </span>
      </span>
      <span
        className={`relative h-6 w-11 shrink-0 rounded-pill transition-colors duration-standard ${
          airplane ? "bg-warning" : "bg-border"
        }`}
      >
        <span
          className={`absolute top-[2px] h-5 w-5 rounded-pill bg-white transition-all duration-standard ${
            airplane ? "start-[22px]" : "start-[2px]"
          }`}
        />
      </span>
    </button>
  );
}
