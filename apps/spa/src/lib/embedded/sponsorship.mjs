/**
 * Who pays for a transaction.
 *
 * The promise is that a Dovizir customer never needs ETH. That is honoured in
 * three ways, and this module is the single place the choice is made:
 *
 *   · friendly transfer, first of the day → the sarraf sponsors it. This is the
 *     headline "send money free" feature, and its cost is the sarraf's cost of
 *     acquiring and keeping a customer.
 *   · friendly transfer, later the same day → the user pays, but in HAWALA via
 *     the token paymaster, so they still never hold ETH. A fraction of a cent.
 *   · purchase → always sponsored, exempt from the quota, because the seller's
 *     premium on that sale is what funds it. Rate-limiting purchases would
 *     throttle the revenue that pays for the sponsorship.
 *
 * `payer: "user-eth"` is deliberately not a value this function can return.
 * If it ever appears, the product promise is broken.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} input
 * @param {"friendly"|"purchase"} input.kind
 * @param {number[]} input.sponsoredAt  epoch-ms of prior SPONSORED transactions
 * @param {number} input.now            epoch-ms; passed in, never read from the clock
 * @param {boolean} [input.paymasterAvailable=true]
 * @returns {{payer: "sarraf"|"user-hawala", reason: string}}
 */
export function decideFunding({ kind, sponsoredAt = [], now, paymasterAvailable = true }) {
  // Degradation rule (mvp.md §4): no off-chain service may strand a user. If
  // the paymaster is down the transaction still goes through, paid in hawala.
  if (!paymasterAvailable) return { payer: "user-hawala", reason: "paymaster-unavailable" };

  // The seller's premium funds a purchase's gas, so it is never rate-limited.
  if (kind === "purchase") return { payer: "sarraf", reason: "purchase-exempt" };

  // Rolling 24h, not a calendar day: calendar days need a timezone, and the
  // user's timezone is a thing we would then have to be right about — while a
  // customer near midnight would see two free transfers in a few minutes.
  // Scan the whole history: checking only the most recent entry would re-grant
  // the quota whenever an older sponsorship happened to sort last.
  const usedToday = sponsoredAt.some((t) => now - t < DAY_MS);
  return usedToday
    ? { payer: "user-hawala", reason: "daily-quota-used" }
    : { payer: "sarraf", reason: "daily-free-transfer" };
}
