"use client";

import { useSignTypedData } from "wagmi";
import {
  BASE_SEPOLIA_CHAIN_ID,
  buildFirmQuoteTypedData,
  buildIndicativeRateTypedData,
  randomQuoteId,
  type FirmQuote,
  type Hex,
  type IndicativeRate,
  type RampDirection,
} from "@dovizir/sdk";

/**
 * Sarraf-side EIP-712 signing for the two rate tiers (fiat-ramp.md §2). Signs
 * with the connected desk wallet and returns the wire payload (string-encoded
 * integers) the indexer's POST endpoints expect.
 */
export function useRampSign() {
  const { signTypedDataAsync } = useSignTypedData();

  /** Sign the current indicative board rate for a (sarraf, fiat) corridor. */
  async function signIndicativeRate(input: {
    sarraf: Hex;
    fiat: string;
    buyRate: string;
    sellRate: string;
    minUsdt: string;
    maxUsdt: string;
    nonce: number;
  }) {
    const effectiveFrom = Math.floor(Date.now() / 1000);
    const rate: IndicativeRate = {
      sarraf: input.sarraf,
      fiat: input.fiat,
      buyRate: input.buyRate,
      sellRate: input.sellRate,
      minUsdt: input.minUsdt,
      maxUsdt: input.maxUsdt,
      effectiveFrom: BigInt(effectiveFrom),
      nonce: BigInt(input.nonce),
    };
    const signature = await signTypedDataAsync(
      buildIndicativeRateTypedData(rate, BASE_SEPOLIA_CHAIN_ID),
    );
    return {
      rate: {
        sarraf: input.sarraf,
        fiat: input.fiat,
        buyRate: input.buyRate,
        sellRate: input.sellRate,
        minUsdt: input.minUsdt,
        maxUsdt: input.maxUsdt,
        effectiveFrom,
        nonce: input.nonce,
      },
      signature,
    };
  }

  /** Sign a short-lived firm quote in answer to a customer RFQ. */
  async function signFirmQuote(input: {
    sarraf: Hex;
    customer: Hex;
    direction: RampDirection;
    usdtAmount: string;
    fiatAmount: string;
    ttlSeconds?: number;
    nonce: number;
  }) {
    const validUntil = Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 180);
    const quoteId = randomQuoteId();
    const quote: FirmQuote = {
      sarraf: input.sarraf,
      customer: input.customer,
      direction: input.direction,
      usdtAmount: input.usdtAmount,
      fiatAmount: input.fiatAmount,
      validUntil: BigInt(validUntil),
      quoteId,
      nonce: BigInt(input.nonce),
    };
    const signature = await signTypedDataAsync(
      buildFirmQuoteTypedData(quote, BASE_SEPOLIA_CHAIN_ID),
    );
    return {
      quote: {
        sarraf: input.sarraf,
        customer: input.customer,
        direction: input.direction,
        usdtAmount: input.usdtAmount,
        fiatAmount: input.fiatAmount,
        validUntil,
        quoteId,
        nonce: input.nonce,
      },
      signature,
    };
  }

  return { signIndicativeRate, signFirmQuote };
}
