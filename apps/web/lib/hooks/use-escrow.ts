"use client";

import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { keccak256, stringToHex, type Hex } from "viem";
import { escrowAbi, iouTokenAbi } from "@dovizir/sdk";
import { useAddresses } from "./use-addresses";

/**
 * P2P escrow actions (fiat-ramp §4, Escrow.sol). Every call is a real on-chain
 * write followed by a receipt wait, mirroring the ramp `use*` hooks. The escrow
 * derives the arbiter from the tranche on-chain, so the UI never passes it.
 *
 * Custody note: to lock IOU the maker must first grant the escrow ERC-1155
 * operator approval (one-time), which {createOrder} ensures before locking.
 */
export function useEscrow() {
  const { address } = useAccount();
  const { addresses, deployed } = useAddresses();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();

  function requireReady() {
    if (!deployed || !publicClient) throw new Error("Contracts not deployed");
    if (!address) throw new Error("Not connected");
  }

  type EscrowFn =
    | "createOrder"
    | "fillOrder"
    | "claimFiatPaid"
    | "confirmReceived"
    | "cancel"
    | "raiseDispute"
    | "resolve";

  async function send(functionName: EscrowFn, args: readonly unknown[]): Promise<Hex> {
    requireReady();
    const hash = await writeContractAsync({
      address: addresses.escrow,
      abi: escrowAbi,
      functionName,
      args,
    } as never);
    await publicClient!.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Ensure the escrow can custody the maker's IOU (idempotent). */
  async function ensureApproval(): Promise<void> {
    requireReady();
    const approved = (await publicClient!.readContract({
      address: addresses.iouToken,
      abi: iouTokenAbi,
      functionName: "isApprovedForAll",
      args: [address!, addresses.escrow],
    })) as boolean;
    if (approved) return;
    const hash = await writeContractAsync({
      address: addresses.iouToken,
      abi: iouTokenAbi,
      functionName: "setApprovalForAll",
      args: [addresses.escrow, true],
    });
    await publicClient!.waitForTransactionReceipt({ hash });
  }

  /**
   * Maker locks `usdtAmount` of the `sellerSarraf` tranche and posts a firm
   * P2P offer. Returns the new order id (read from nextOrderId just before the
   * write — createOrder consumes exactly that id). The quote hash anchors the
   * agreed terms for dispute evidence.
   */
  async function createOrder(input: {
    sellerSarraf: Hex;
    usdtAmount: bigint;
    fiat: string;
    fiatAmount: bigint;
    paymentWindow: number;
  }): Promise<string> {
    requireReady();
    await ensureApproval();
    const orderId = (await publicClient!.readContract({
      address: addresses.escrow,
      abi: escrowAbi,
      functionName: "nextOrderId",
    })) as bigint;
    const quoteHash = keccak256(
      stringToHex(
        JSON.stringify({
          sellerSarraf: input.sellerSarraf,
          usdtAmount: input.usdtAmount.toString(),
          fiat: input.fiat,
          fiatAmount: input.fiatAmount.toString(),
        }),
      ),
    );
    await send("createOrder", [
      input.sellerSarraf,
      input.usdtAmount,
      input.fiat,
      input.fiatAmount,
      quoteHash,
      BigInt(input.paymentWindow),
    ]);
    return orderId.toString();
  }

  const fillOrder = (orderId: string) => send("fillOrder", [BigInt(orderId)]);
  const claimFiatPaid = (orderId: string, receiptHash: Hex) =>
    send("claimFiatPaid", [BigInt(orderId), receiptHash]);
  const confirmReceived = (orderId: string) => send("confirmReceived", [BigInt(orderId)]);
  const cancel = (orderId: string) => send("cancel", [BigInt(orderId)]);
  const raiseDispute = (orderId: string) => send("raiseDispute", [BigInt(orderId)]);
  const resolve = (orderId: string, toTaker: boolean) =>
    send("resolve", [BigInt(orderId), toTaker]);

  return {
    createOrder,
    fillOrder,
    claimFiatPaid,
    confirmReceived,
    cancel,
    raiseDispute,
    resolve,
    isPending,
  };
}

/** The arbiter for a tranche, recomputed off-chain exactly as Escrow derives it. */
export function useArbiterOf(orderId: string | null) {
  const { addresses, deployed } = useAddresses();
  return useReadContract({
    address: addresses.escrow,
    abi: escrowAbi,
    functionName: "arbiterOf",
    args: orderId ? [BigInt(orderId)] : undefined,
    query: { enabled: deployed && orderId !== null },
  });
}
