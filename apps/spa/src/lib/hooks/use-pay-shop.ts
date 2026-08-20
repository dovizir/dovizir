"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { decodeEventLog, type Hex } from "viem";
import { getAddresses, iouTokenAbi, purchaseInsuranceAbi } from "@dovizir/sdk";

/**
 * Pay a registered shop through PurchaseInsurance.payShop — the insured
 * purchase path. Settlement is instant (the shop is paid in the same
 * transaction); what the premium buys is the coverage window that opens
 * alongside it.
 *
 * First use requires a one-time operator approval so the insurance contract
 * can move the buyer's hawala; the hook checks before asking, so repeat buyers
 * sign exactly one transaction.
 *
 * The purchaseId comes from the receipt's PurchaseRecorded event — a write
 * only returns a tx hash, and guessing ids is how off-by-one bugs are born.
 */
export function usePayShop() {
  const { address } = useAccount();
  const pub = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [isPending, setPending] = useState(false);

  async function payShop(shop: Hex, amount: bigint) {
    const { iouToken, purchaseInsurance } = getAddresses();
    if (!address || !pub) throw new Error("not connected");
    setPending(true);
    try {
      const approved = (await pub.readContract({
        address: iouToken,
        abi: iouTokenAbi,
        functionName: "isApprovedForAll",
        args: [address, purchaseInsurance],
      })) as boolean;
      if (!approved) {
        const h = await writeContractAsync({
          address: iouToken,
          abi: iouTokenAbi,
          functionName: "setApprovalForAll",
          args: [purchaseInsurance, true],
        });
        await pub.waitForTransactionReceipt({ hash: h });
      }

      const hash = await writeContractAsync({
        address: purchaseInsurance,
        abi: purchaseInsuranceAbi,
        functionName: "payShop",
        args: [shop, amount],
      });
      const receipt = await pub.waitForTransactionReceipt({ hash });

      let purchaseId: bigint | null = null;
      for (const log of receipt.logs) {
        try {
          const ev = decodeEventLog({
            abi: purchaseInsuranceAbi,
            data: log.data,
            topics: log.topics,
          });
          if (ev.eventName === "PurchaseRecorded") {
            purchaseId = (ev.args as { purchaseId: bigint }).purchaseId;
            break;
          }
        } catch {
          /* a log from another contract in the same tx — not ours */
        }
      }
      return { hash, purchaseId };
    } finally {
      setPending(false);
    }
  }

  async function confirmReceipt(purchaseId: bigint) {
    const { purchaseInsurance } = getAddresses();
    if (!pub) throw new Error("not connected");
    setPending(true);
    try {
      const hash = await writeContractAsync({
        address: purchaseInsurance,
        abi: purchaseInsuranceAbi,
        functionName: "confirmReceipt",
        args: [purchaseId],
      });
      await pub.waitForTransactionReceipt({ hash });
      return hash;
    } finally {
      setPending(false);
    }
  }

  return { payShop, confirmReceipt, isPending };
}
