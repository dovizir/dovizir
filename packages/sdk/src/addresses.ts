/**
 * Typed deployment address config.
 *
 * Addresses come from NEXT_PUBLIC_*_ADDRESS env vars (inlined at build time by
 * Next.js) and default to the zero address until the M1 contracts are deployed
 * to Base Sepolia. `isDeployed()` gates every on-chain feature so the app
 * renders a "not deployed yet" state instead of crashing.
 */

export type Hex = `0x${string}`;

export const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";

export interface DovizirAddresses {
  iouToken: Hex;
  purchaseInsurance: Hex;
  memberRegistry: Hex;
  reservePool: Hex;
  insuranceFund: Hex;
  sarrafRegistry: Hex;
  noteVault: Hex;
  escrow: Hex;
  usdt: Hex;
}

function addr(value: string | undefined): Hex {
  if (!value) return ZERO_ADDRESS;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    console.warn(`@dovizir/sdk: ignoring malformed address "${value}"`);
    return ZERO_ADDRESS;
  }
  return value as Hex;
}

/** Reads the deployment from NEXT_PUBLIC_* env. Zero addresses until deployed. */
export function getAddresses(): DovizirAddresses {
  return {
    iouToken: addr(process.env.NEXT_PUBLIC_IOU_TOKEN_ADDRESS),
    purchaseInsurance: addr(process.env.NEXT_PUBLIC_PURCHASE_INSURANCE_ADDRESS),
    memberRegistry: addr(process.env.NEXT_PUBLIC_MEMBER_REGISTRY_ADDRESS),
    reservePool: addr(process.env.NEXT_PUBLIC_RESERVE_POOL_ADDRESS),
    insuranceFund: addr(process.env.NEXT_PUBLIC_INSURANCE_FUND_ADDRESS),
    sarrafRegistry: addr(process.env.NEXT_PUBLIC_SARRAF_REGISTRY_ADDRESS),
    noteVault: addr(process.env.NEXT_PUBLIC_NOTE_VAULT_ADDRESS),
    escrow: addr(process.env.NEXT_PUBLIC_ESCROW_ADDRESS),
    usdt: addr(process.env.NEXT_PUBLIC_USDT_ADDRESS),
  };
}

/**
 * Known sarraf addresses (comma-separated NEXT_PUBLIC_SARRAF_ADDRESSES).
 * Tranche ids derive from these; a later milestone replaces this static list
 * with the indexer's live sarraf set.
 */
export function getKnownSarrafs(): Hex[] {
  const raw = process.env.NEXT_PUBLIC_SARRAF_ADDRESSES ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s)) as Hex[];
}

let warned = false;

/** True once the core contracts have real addresses configured. */
export function isDeployed(addresses: DovizirAddresses = getAddresses()): boolean {
  const deployed =
    addresses.iouToken !== ZERO_ADDRESS && addresses.reservePool !== ZERO_ADDRESS;
  if (!deployed && !warned) {
    warned = true;
    console.warn(
      "@dovizir/sdk: contract addresses are unset (0x0). Deploy the M1 contracts " +
        "to Base Sepolia first, then set NEXT_PUBLIC_IOU_TOKEN_ADDRESS, " +
        "NEXT_PUBLIC_RESERVE_POOL_ADDRESS, NEXT_PUBLIC_MEMBER_REGISTRY_ADDRESS, " +
        "NEXT_PUBLIC_USDT_ADDRESS, ... On-chain features are disabled until then.",
    );
  }
  return deployed;
}
