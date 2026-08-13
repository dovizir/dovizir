"use client";

import { useAccount, useReadContract } from "wagmi";
import { memberRegistryAbi, ZERO_ADDRESS } from "@dovizir/sdk";
import { useAddresses } from "./use-addresses";

/** The connected member's sponsoring sarraf (zero address = not a member). */
export function useSarraf() {
  const { address } = useAccount();
  const { addresses, deployed } = useAddresses();

  const query = useReadContract({
    address: addresses.memberRegistry,
    abi: memberRegistryAbi,
    functionName: "sarrafOf",
    args: address ? [address] : undefined,
    query: { enabled: deployed && !!address },
  });

  const sarraf = query.data && query.data !== ZERO_ADDRESS ? query.data : undefined;
  return { sarraf, isLoading: query.isLoading, refetch: query.refetch };
}
