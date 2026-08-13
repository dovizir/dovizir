/** Target chain: Base Sepolia. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Public RPC; override with NEXT_PUBLIC_RPC_URL for a dedicated endpoint. */
export const DEFAULT_RPC_URL = "https://sepolia.base.org";

export function getRpcUrl(): string {
  return process.env.NEXT_PUBLIC_RPC_URL ?? DEFAULT_RPC_URL;
}
