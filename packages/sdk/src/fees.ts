/** ReservePool: FEE_BPS = 90 (0.9%), fee rounds DOWN (frozen spec). */
export const REDEEM_FEE_BPS = 90n;
export const BPS_DENOMINATOR = 10_000n;

export interface RedeemSplit {
  /** Gross amount burned from the holder's tranche balance. */
  gross: bigint;
  /** 0.9% fee routed to the InsuranceFund (rounds down). */
  fee: bigint;
  /** Net USDT paid out to the holder. */
  net: bigint;
}

/** Mirrors ReservePool.redeem fee math exactly (e.g. 200 -> 198.20 / 1.80). */
export function computeRedeemSplit(gross: bigint): RedeemSplit {
  const fee = (gross * REDEEM_FEE_BPS) / BPS_DENOMINATOR;
  return { gross, fee, net: gross - fee };
}
