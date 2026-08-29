"use client";

import { useEffect } from "react";
import { useRouteError } from "react-router-dom";
import { useTranslations } from "next-intl";
// @ts-expect-error — plain-JS policy module, tested standalone (chunk-error.test.mjs)
import { isChunkLoadError, shouldAutoReload } from "@/lib/chunk-error.mjs";

const RELOADED_KEY = "dovizir.chunkReloaded";

/**
 * Route-level error boundary. Its one special power: healing stale-chunk
 * failures after a deploy (old shell asking for deleted hashed chunks) with a
 * single automatic reload — the no-cache shell + autoUpdate service worker
 * then pick up the new build. Everything else renders a calm, localized
 * error card instead of react-router's raw default screen.
 */
export function RouteError() {
  const error = useRouteError();
  const t = useTranslations("common.appError");

  const chunk = isChunkLoadError(error);
  const autoReload =
    chunk &&
    typeof window !== "undefined" &&
    shouldAutoReload({ alreadyReloaded: sessionStorage.getItem(RELOADED_KEY) === "1" });

  useEffect(() => {
    if (!autoReload) return;
    sessionStorage.setItem(RELOADED_KEY, "1");
    window.location.reload();
  }, [autoReload]);

  if (autoReload) return null; // reloading — don't flash an error

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-lg p-xl text-center">
      <p className="text-lg font-medium text-foreground">
        {chunk ? t("updatedTitle") : t("title")}
      </p>
      <p className="text-sm text-muted">{chunk ? t("updatedBody") : t("body")}</p>
      <button
        type="button"
        onClick={() => {
          sessionStorage.removeItem(RELOADED_KEY);
          window.location.reload();
        }}
        className="rounded-pill bg-primary px-xl py-sm text-sm font-medium text-primary-foreground"
      >
        {t("reload")}
      </button>
    </div>
  );
}
