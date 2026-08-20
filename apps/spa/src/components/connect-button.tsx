"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useDovizirWallet } from "@/lib/embedded/use-wallet";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Wallet control — the embedded-wallet replacement for "Connect wallet".
 * First-time users get a "Create your wallet" CTA (mints the embedded wallet,
 * no seed phrase); returning users see their address with a reset affordance.
 *
 * AA-SEAM: when the passkey smart-account connector lands this becomes
 * "Sign in" (WebAuthn get) with the same surface.
 */
export function ConnectButton() {
  const t = useTranslations("wallet");
  const { address, isReady, isPending, reset } = useDovizirWallet();
  const [open, setOpen] = useState(false);

  if (isReady && address) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={t("yourWallet")}
          className="whitespace-nowrap rounded-pill border border-border bg-surface px-lg py-sm text-sm font-medium text-foreground"
        >
          <span dir="ltr">{shortAddress(address)}</span>
        </button>
        {open && (
          <div className="absolute end-0 z-20 mt-xs w-44 rounded-md border border-border bg-background p-xs shadow-md">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(address);
                setOpen(false);
              }}
              className="block w-full rounded-sm px-md py-sm text-start text-sm text-foreground hover:bg-surface"
            >
              {t("copyAddress")}
            </button>
            <button
              type="button"
              onClick={async () => {
                setOpen(false);
                await reset();
              }}
              className="block w-full rounded-sm px-md py-sm text-start text-sm text-danger hover:bg-surface"
            >
              {t("reset")}
            </button>
          </div>
        )}
      </div>
    );
  }

  // First-time users are routed through onboarding (join sarraf -> passkey
  // ceremony -> ready) instead of a bare inline create.
  return (
    <Link
      href="/welcome"
      className="whitespace-nowrap rounded-pill bg-primary px-lg py-sm text-sm font-medium text-primary-foreground shadow-sm"
    >
      {isPending ? t("creating") : t("createWallet")}
    </Link>
  );
}
