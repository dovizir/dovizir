"use client";

import { useTranslations } from "next-intl";
import { useAccount, useConnect, useDisconnect } from "wagmi";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// AA-SEAM: with the passkey smart account this becomes "Sign in" (WebAuthn
// create/get) instead of an EOA connector picker; same wagmi surface below.
export function ConnectButton() {
  const t = useTranslations("common");
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button
        type="button"
        onClick={() => disconnect()}
        title={t("disconnect")}
        className="rounded-pill border border-border bg-surface px-lg py-sm text-sm font-medium text-foreground"
      >
        <span dir="ltr">{shortAddress(address)}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={isPending || connectors.length === 0}
      onClick={() => connect({ connector: connectors[0] })}
      className="rounded-pill bg-primary px-lg py-sm text-sm font-medium text-primary-foreground shadow-sm disabled:opacity-50"
    >
      {isPending ? t("connecting") : t("connect")}
    </button>
  );
}
