"use client";

import { useTranslations } from "next-intl";
import { pickupHandoff } from "@/lib/notes/handoff";

/**
 * "Scan" input for the browser demo: paste the payload or pick it up from the
 * other tab on this device. Camera scanning needs native/Capacitor and is the
 * AA/native seam — surfaced as a disabled affordance, not wired.
 */
export function QrScanInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const t = useTranslations("notes");

  return (
    <div className="flex flex-col gap-sm">
      <textarea
        dir="ltr"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-none rounded-md border border-border bg-surface-alt px-lg py-md font-mono text-xs text-foreground outline-none placeholder:text-muted focus:border-focus"
      />
      <div className="flex flex-wrap gap-sm">
        <button
          type="button"
          onClick={() => {
            const p = pickupHandoff();
            if (p) onChange(p);
          }}
          className="rounded-pill border border-primary px-lg py-sm text-xs font-bold text-primary"
        >
          {t("scan.pickup")}
        </button>
        <button
          type="button"
          disabled
          title={t("scan.cameraSeam")}
          className="rounded-pill border border-border px-lg py-sm text-xs font-medium text-muted opacity-60"
        >
          {t("scan.camera")}
        </button>
      </div>
      <p className="text-xs text-muted">{t("scan.cameraSeam")}</p>
    </div>
  );
}
