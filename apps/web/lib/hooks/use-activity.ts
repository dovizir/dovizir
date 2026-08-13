"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import { parseAbiItem } from "viem";
import { ZERO_ADDRESS, type Hex } from "@dovizir/sdk";
import { useAddresses } from "./use-addresses";

export interface ActivityItem {
  direction: "in" | "out";
  counterparty: Hex;
  amount: bigint;
  txHash: Hex;
  blockNumber: bigint;
}

const transferSingle = parseAbiItem(
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
);

/** How far back to scan on the public RPC (indexer replaces this later). */
const LOOKBACK_BLOCKS = 10_000n;

/** Recent IOU transfers touching the connected account (mints count as "in"). */
export function useActivity(limit = 10) {
  const { address } = useAccount();
  const { addresses, deployed } = useAddresses();
  const publicClient = usePublicClient();

  return useQuery({
    queryKey: ["activity", addresses.iouToken, address],
    enabled: deployed && !!address && !!publicClient,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ActivityItem[]> => {
      if (!publicClient || !address) return [];
      try {
        const latest = await publicClient.getBlockNumber();
        const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
        const [incoming, outgoing] = await Promise.all([
          publicClient.getLogs({
            address: addresses.iouToken,
            event: transferSingle,
            args: { to: address },
            fromBlock,
          }),
          publicClient.getLogs({
            address: addresses.iouToken,
            event: transferSingle,
            args: { from: address },
            fromBlock,
          }),
        ]);
        return [...incoming, ...outgoing]
          .filter((log) => log.args.value && log.args.value > 0n)
          .map((log): ActivityItem => {
            const isIncoming = log.args.to?.toLowerCase() === address.toLowerCase();
            return {
              direction: isIncoming ? "in" : "out",
              counterparty: (isIncoming ? log.args.from : log.args.to) ?? ZERO_ADDRESS,
              amount: log.args.value ?? 0n,
              txHash: log.transactionHash,
              blockNumber: log.blockNumber,
            };
          })
          .sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : -1))
          .slice(0, limit);
      } catch {
        // Public RPC log-range limits etc. — degrade to an empty list.
        return [];
      }
    },
  });
}
