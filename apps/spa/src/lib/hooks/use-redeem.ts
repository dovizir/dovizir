"use client";

import { useWriteContract } from "wagmi";
import { computeRedeemSplit, reservePoolAbi, type Hex } from "@dovizir/sdk";
import { useAddresses } from "./use-addresses";

/**
 * Redeem tranche IOU for USDT via ReservePool.redeem: burns the caller's
 * balance in the chosen sarraf's tranche, pays out net of the 0.9% fee.
 */
export function useRedeem() {
  const { addresses, deployed } = useAddresses();
  const { writeContractAsync, isPending } = useWriteContract();

  async function redeem(sarraf: Hex, amount: bigint) {
    if (!deployed) throw new Error("Contracts not deployed");
    return writeContractAsync({
      address: addresses.reservePool,
      abi: reservePoolAbi,
      functionName: "redeem",
      args: [sarraf, amount],
    });
  }

  return {
    redeem,
    /** Mirror of the on-chain fee math for the 198.20 / 1.80 preview. */
    previewSplit: computeRedeemSplit,
    isPending,
  };
}
