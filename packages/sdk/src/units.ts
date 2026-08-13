/** IOU/USDT amounts use 6 decimals (MockUsdt.decimals() == 6). */
export const IOU_DECIMALS = 6;

const SCALE = 10n ** BigInt(IOU_DECIMALS);

/** "200" | "200.5" -> 200500000n. Throws on malformed input. */
export function parseIou(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d*)?$/.test(trimmed)) {
    throw new Error(`Invalid amount: "${value}"`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "000000").slice(0, IOU_DECIMALS);
  return BigInt(whole) * SCALE + BigInt(fracPadded);
}

/** 200500000n -> "200.50" (trims to at most `maxFrac` fraction digits). */
export function formatIou(value: bigint, maxFrac = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(IOU_DECIMALS, "0").slice(0, maxFrac);
  const fracTrimmed = frac.replace(/0+$/, "");
  const body = fracTrimmed.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${body}` : body;
}
