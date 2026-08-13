"use client";

import { useMemo } from "react";
import { useAccount, useReadContract } from "wagmi";
import { iouTokenAbi, trancheId, type Hex } from "@dovizir/sdk";
import { useAddresses } from "./use-addresses";
import { useSarraf } from "./use-sarraf";

export interface TrancheBalance {
  sarraf: Hex;
  id: bigint;
  balance: bigint;
}

/**
 * Aggregated IOU balance: sums the holder's ERC-1155 balance across all known
 * sarraf tranches (plus their own sarraf) into the ONE number wallets show —
 * tranches are an accounting detail users never see. The static sarraf list
 * (env) is replaced by the indexer's live set in a later milestone.
 */
export function useIouBalance() {
  const { address } = useAccount();
  const { addresses, knownSarrafs, deployed } = useAddresses();
  const { sarraf: ownSarraf } = useSarraf();

  const sarrafs = useMemo(() => {
    const set = new Set<Hex>(knownSarrafs);
    if (ownSarraf) set.add(ownSarraf);
    return [...set];
  }, [knownSarrafs, ownSarraf]);

  const query = useReadContract({
    address: addresses.iouToken,
    abi: iouTokenAbi,
    functionName: "balanceOfBatch",
    args: address
      ? [sarrafs.map(() => address), sarrafs.map((s) => trancheId(s))]
      : undefined,
    query: { enabled: deployed && !!address && sarrafs.length > 0 },
  });

  const byTranche: TrancheBalance[] = useMemo(() => {
    if (!query.data) return [];
    return sarrafs
      .map((sarraf, i) => ({
        sarraf,
        id: trancheId(sarraf),
        balance: query.data[i] ?? 0n,
      }))
      .filter((t) => t.balance > 0n)
      .sort((a, b) => (b.balance > a.balance ? 1 : -1));
  }, [query.data, sarrafs]);

  const total = useMemo(
    () => byTranche.reduce((sum, t) => sum + t.balance, 0n),
    [byTranche],
  );

  return {
    /** The one aggregated number shown to the user. */
    total,
    /** Per-tranche detail (largest first) for spend routing. */
    byTranche,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
