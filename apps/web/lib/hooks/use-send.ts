"use client";

import { useState } from "react";
import { useAccount, useSignTypedData, useWriteContract } from "wagmi";
import {
  buildTransferAuthorization,
  iouTokenAbi,
  type Hex,
  type TransferAuthorization,
} from "@dovizir/sdk";
import { useAddresses } from "./use-addresses";
import { useIouBalance, type TrancheBalance } from "./use-iou-balance";

export interface SignedAuthorization {
  authorization: TransferAuthorization;
  signature: Hex;
}

/** Largest tranche that alone covers the amount (M2: single-tranche sends). */
function pickTranche(byTranche: TrancheBalance[], amount: bigint) {
  return byTranche.find((t) => t.balance >= amount);
}

/**
 * Send IOU two ways:
 *  - direct: safeTransferFrom from the connected wallet, on-chain now;
 *  - courier: sign an EIP-3009-style authorization (frozen AuthLib domain)
 *    that ANY relayer can submit via transferWithAuthorization — the seam the
 *    gas-sponsored zero-fee UX plugs into.
 */
export function useSend() {
  const { address } = useAccount();
  const { addresses, deployed } = useAddresses();
  const { byTranche } = useIouBalance();
  const { writeContractAsync, isPending: isSending } = useWriteContract();
  const { signTypedDataAsync, isPending: isSigning } = useSignTypedData();
  const [signed, setSigned] = useState<SignedAuthorization | null>(null);

  function requireTranche(amount: bigint) {
    if (!deployed) throw new Error("Contracts not deployed");
    if (!address) throw new Error("Not connected");
    const tranche = pickTranche(byTranche, amount);
    if (!tranche) throw new Error("insufficient");
    return tranche;
  }

  /** Direct on-chain transfer. */
  async function sendDirect(to: Hex, amount: bigint) {
    const tranche = requireTranche(amount);
    return writeContractAsync({
      address: addresses.iouToken,
      abi: iouTokenAbi,
      functionName: "safeTransferFrom",
      args: [address!, to, tranche.id, amount, "0x"],
    });
  }

  /** Courier path, step 1: sign the offline authorization. */
  async function signCourierAuthorization(to: Hex, amount: bigint) {
    const tranche = requireTranche(amount);
    const typedData = buildTransferAuthorization({
      iouToken: addresses.iouToken,
      from: address!,
      to,
      id: tranche.id,
      amount,
    });
    const signature = await signTypedDataAsync(typedData);
    const result: SignedAuthorization = {
      authorization: typedData.message,
      signature,
    };
    setSigned(result);
    return result;
  }

  /** Courier path, step 2: relay (callable by anyone, incl. the sender). */
  async function relayAuthorization({ authorization: a, signature }: SignedAuthorization) {
    if (!deployed) throw new Error("Contracts not deployed");
    return writeContractAsync({
      address: addresses.iouToken,
      abi: iouTokenAbi,
      functionName: "transferWithAuthorization",
      args: [a.from, a.to, a.id, a.amount, a.validAfter, a.validBefore, a.nonce, signature],
    });
  }

  return {
    sendDirect,
    signCourierAuthorization,
    relayAuthorization,
    signed,
    clearSigned: () => setSigned(null),
    isSending,
    isSigning,
  };
}
