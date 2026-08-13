"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { indexer, type IndexerHealth, type SarrafView } from "@/lib/indexer";

/**
 * The connected sarraf's book, live from the indexer. Polls every 5s.
 * `addr` overrides the connected account (e.g. for a demo/known sarraf).
 */
export function useSarrafBook(addr?: string) {
  const { address } = useAccount();
  const sarraf = (addr ?? address)?.toLowerCase();

  const book = useQuery<SarrafView>({
    queryKey: ["indexer", "sarraf", sarraf],
    enabled: !!sarraf,
    refetchInterval: 5_000,
    retry: 1,
    queryFn: ({ signal }) => indexer.sarraf(sarraf!, signal),
  });

  const health = useQuery<IndexerHealth>({
    queryKey: ["indexer", "health"],
    refetchInterval: 10_000,
    retry: 1,
    queryFn: ({ signal }) => indexer.health(signal),
  });

  return { sarraf, book, health };
}
