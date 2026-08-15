"use client";

import { usePublicClient, useWriteContract } from "wagmi";
import { reservePoolAbi, type Hex } from "@dovizir/sdk";
import { useAddresses } from "./use-addresses";

/**
 * Sarraf-side issuance for the on-ramp: ReservePool.issue(customer, amount)
 * mints backed IOU into the customer's tranche. Called from the order console
 * once the Sarraf has verified the fiat receipt. Waits for the receipt so the
 * indexer can link the resulting Issued event and close the order (SETTLED).
 */
export function useIssue() {
  const { addresses, deployed } = useAddresses();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();

  async function issue(customer: Hex, amount: bigint): Promise<Hex> {
    if (!deployed || !publicClient) throw new Error("Contracts not deployed");
    const hash = await writeContractAsync({
      address: addresses.reservePool,
      abi: reservePoolAbi,
      functionName: "issue",
      args: [customer, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  return { issue, isPending };
}
