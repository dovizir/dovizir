import { recoverTypedDataAddress, type Hex } from "viem";
import { BASE_SEPOLIA_CHAIN_ID } from "./chain";

/**
 * EIP-712 typed data for the fiat-ramp rate model (docs/design/fiat-ramp.md §2).
 *
 * Two tiers, both signed by the Sarraf, mirroring authorization.ts's domain
 * style — but these records live OFF-CHAIN (indexer-served), so the domain has
 * no `verifyingContract`; it is pinned only by name/version/chainId. That is
 * enough: the signer is recovered and compared to `rate.sarraf` / `quote.sarraf`.
 *
 *   IndicativeRate — the daily guidance board rate, valid until superseded.
 *   FirmQuote      — a short-lived, size-specific executable price from an RFQ.
 *
 * Numeric money fields (rates, amounts) are carried as decimal STRINGS so the
 * fiat side keeps full precision regardless of the corridor's smallest unit
 * (rial has no fraction; the record stays currency-agnostic). Only the clock /
 * nonce fields are on-chain integer types.
 */

export const RATES_DOMAIN_NAME = "Dovizir Rates";
export const RATES_DOMAIN_VERSION = "1";

export function ratesDomain(chainId: number = BASE_SEPOLIA_CHAIN_ID) {
  return {
    name: RATES_DOMAIN_NAME,
    version: RATES_DOMAIN_VERSION,
    chainId,
  } as const;
}

export const INDICATIVE_RATE_TYPES = {
  IndicativeRate: [
    { name: "sarraf", type: "address" },
    { name: "fiat", type: "string" },
    { name: "buyRate", type: "string" },
    { name: "sellRate", type: "string" },
    { name: "minUsdt", type: "string" },
    { name: "maxUsdt", type: "string" },
    { name: "effectiveFrom", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export const FIRM_QUOTE_TYPES = {
  FirmQuote: [
    { name: "sarraf", type: "address" },
    { name: "customer", type: "address" },
    { name: "direction", type: "string" },
    { name: "usdtAmount", type: "string" },
    { name: "fiatAmount", type: "string" },
    { name: "validUntil", type: "uint64" },
    { name: "quoteId", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** on-ramp = fiat→IOU (Sarraf sells USDT); off-ramp = IOU→fiat (Sarraf buys). */
export type RampDirection = "on-ramp" | "off-ramp";

/** Signed record shape (message values), bigints for the integer fields. */
export interface IndicativeRate {
  sarraf: Hex;
  fiat: string;
  buyRate: string;
  sellRate: string;
  minUsdt: string;
  maxUsdt: string;
  effectiveFrom: bigint;
  nonce: bigint;
}

export interface FirmQuote {
  sarraf: Hex;
  customer: Hex;
  direction: RampDirection;
  usdtAmount: string;
  fiatAmount: string;
  validUntil: bigint;
  quoteId: Hex;
  nonce: bigint;
}

/** Random 32-byte quoteId (browser / Node 20 WebCrypto). */
export function randomQuoteId(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/** Full signTypedData payload for an IndicativeRate. */
export function buildIndicativeRateTypedData(
  rate: IndicativeRate,
  chainId: number = BASE_SEPOLIA_CHAIN_ID,
) {
  return {
    domain: ratesDomain(chainId),
    types: INDICATIVE_RATE_TYPES,
    primaryType: "IndicativeRate" as const,
    message: rate,
  } as const;
}

/** Full signTypedData payload for a FirmQuote. */
export function buildFirmQuoteTypedData(
  quote: FirmQuote,
  chainId: number = BASE_SEPOLIA_CHAIN_ID,
) {
  return {
    domain: ratesDomain(chainId),
    types: FIRM_QUOTE_TYPES,
    primaryType: "FirmQuote" as const,
    message: quote,
  } as const;
}

/** Recover the signer of an IndicativeRate (should equal rate.sarraf). */
export async function recoverIndicativeRateSigner(
  rate: IndicativeRate,
  signature: Hex,
  chainId: number = BASE_SEPOLIA_CHAIN_ID,
): Promise<Hex> {
  return recoverTypedDataAddress({
    ...buildIndicativeRateTypedData(rate, chainId),
    signature,
  });
}

/** True iff `signature` is a valid IndicativeRate signature by rate.sarraf. */
export async function verifyIndicativeRate(
  rate: IndicativeRate,
  signature: Hex,
  chainId: number = BASE_SEPOLIA_CHAIN_ID,
): Promise<boolean> {
  try {
    const signer = await recoverIndicativeRateSigner(rate, signature, chainId);
    return signer.toLowerCase() === rate.sarraf.toLowerCase();
  } catch {
    return false;
  }
}

/** Recover the signer of a FirmQuote (should equal quote.sarraf). */
export async function recoverFirmQuoteSigner(
  quote: FirmQuote,
  signature: Hex,
  chainId: number = BASE_SEPOLIA_CHAIN_ID,
): Promise<Hex> {
  return recoverTypedDataAddress({
    ...buildFirmQuoteTypedData(quote, chainId),
    signature,
  });
}

/** True iff `signature` is a valid FirmQuote signature by quote.sarraf. */
export async function verifyFirmQuote(
  quote: FirmQuote,
  signature: Hex,
  chainId: number = BASE_SEPOLIA_CHAIN_ID,
): Promise<boolean> {
  try {
    const signer = await recoverFirmQuoteSigner(quote, signature, chainId);
    return signer.toLowerCase() === quote.sarraf.toLowerCase();
  } catch {
    return false;
  }
}
