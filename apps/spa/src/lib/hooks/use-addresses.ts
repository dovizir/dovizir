"use client";

import { useMemo } from "react";
import { getAddresses, getKnownSarrafs, isDeployed } from "@dovizir/sdk";

/** Deployment config for the client tree (zero addresses until deployed). */
export function useAddresses() {
  return useMemo(() => {
    const addresses = getAddresses();
    return {
      addresses,
      knownSarrafs: getKnownSarrafs(),
      deployed: isDeployed(addresses),
    };
  }, []);
}
