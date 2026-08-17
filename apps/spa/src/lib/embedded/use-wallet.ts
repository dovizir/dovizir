"use client";

import { useCallback, useEffect } from "react";
import { useAccount, useConnect, useDisconnect, useConfig } from "wagmi";
import type { Hex } from "viem";
import {
  clearEmbeddedWallet,
  getJoinedSarraf,
  setJoinedSarraf,
} from "./account";

/**
 * The one hook the UI uses for the embedded wallet. Wraps wagmi so the rest of
 * the app never sees "connect" semantics — a Dovizir user just HAS a wallet.
 *   · create(): mint the embedded wallet + connect (first run)
 *   · reset():  wipe it (PoC affordance / device handoff)
 *   · joinedSarraf: the Sarraf this user onboarded through
 */
export function useDovizirWallet() {
  const { address, isConnected } = useAccount();
  const { connectAsync, isPending } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const config = useConfig();

  const embedded = config.connectors.find((c) => c.id === "dovizir-embedded");

  const create = useCallback(async () => {
    if (!embedded) throw new Error("embedded connector missing");
    await connectAsync({ connector: embedded });
  }, [connectAsync, embedded]);

  const reset = useCallback(async () => {
    await disconnectAsync().catch(() => {});
    clearEmbeddedWallet();
  }, [disconnectAsync]);

  return {
    address: address as Hex | undefined,
    isReady: isConnected,
    isPending,
    create,
    reset,
    joinedSarraf: getJoinedSarraf(),
  };
}

/**
 * Records the Sarraf a customer arrives through (?sarraf=0x… on any entry
 * link/QR), so their IOU tranche + sponsored gas bind to that Sarraf. Mount
 * once near the app root.
 */
export function useCaptureJoinSarraf() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const param = new URLSearchParams(window.location.search).get("sarraf");
    if (param && /^0x[0-9a-fA-F]{40}$/.test(param)) {
      setJoinedSarraf(param as Hex);
    }
  }, []);
}
