"use client";

import { useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { mockUsdtAbi, reservePoolAbi } from "@dovizir/sdk";
import { useAddresses } from "./use-addresses";

/**
 * Direct on-chain deposit into the ReservePool (sarraf-side backing).
 * The consumer-facing "request deposit from your sarraf" flow is an off-chain
 * request stub for now (see the Deposit screen); the sarraf desk uses this
 * hook to actually fund backing: approve USDT, then ReservePool.deposit.
 */
export function useDeposit() {
  const { addresses, deployed } = useAddresses();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();
  const [step, setStep] = useState<"idle" | "approving" | "depositing">("idle");

  async function deposit(amount: bigint) {
    if (!deployed || !publicClient) throw new Error("Contracts not deployed");
    try {
      setStep("approving");
      const approveHash = await writeContractAsync({
        address: addresses.usdt,
        abi: mockUsdtAbi,
        functionName: "approve",
        args: [addresses.reservePool, amount],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      setStep("depositing");
      const depositHash = await writeContractAsync({
        address: addresses.reservePool,
        abi: reservePoolAbi,
        functionName: "deposit",
        args: [amount],
      });
      await publicClient.waitForTransactionReceipt({ hash: depositHash });
      return depositHash;
    } finally {
      setStep("idle");
    }
  }

  return { deposit, step, isPending };
}
