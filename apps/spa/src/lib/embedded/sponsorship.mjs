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
 * TWO paymasters, and they fail independently:
 *
 *   · the SPONSORING paymaster lets the sarraf pay for someone else;
 *   · the TOKEN paymaster is what lets a user pay in hawala at all.
 *
 * Paying in hawala IS the token paymaster. In ERC-4337 the EntryPoint settles
 * gas in ETH; the only way a user pays in an ERC-20 is for a token paymaster to
 * accept that token and cover the ETH itself. So "sponsorship is down, the user
 * pays in hawala" holds only while the token paymaster is up. An earlier
 * version of this module collapsed both into one flag and claimed nobody could
 * ever be stranded — which was false, and hid the one state that really does
 * block a user.
 *
 * `payer: "user-eth"` is deliberately not a value this function can return: a
 * Dovizir customer holds no ETH, so charging them in it is never an answer.
 * When neither paymaster is available the honest result is `payer: "none"` —
 * blocked. Naming that state is what lets the UI say something true instead of
 * failing obscurely.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} input
 * @param {"friendly"|"purchase"} input.kind
 * @param {number[]} input.sponsoredAt  epoch-ms of prior SPONSORED transactions
 * @param {number} input.now            epoch-ms; passed in, never read from the clock
 * @param {boolean} [input.sponsorAvailable=true]      sarraf-funded sponsorship
 * @param {boolean} [input.tokenPaymasterAvailable=true] lets the user pay in hawala
 * @returns {{payer: "sarraf"|"user-hawala"|"none", reason: string}}
 */
export function decideFunding({
  kind,
  sponsoredAt = [],
  now,
  sponsorAvailable = true,
  tokenPaymasterAvailable = true,
}) {
  /** The user pays their own way — possible only via the token paymaster. */
  const userPays = (reason) =>
    tokenPaymasterAvailable
      ? { payer: "user-hawala", reason }
      : { payer: "none", reason: "no-paymaster" };

  // The seller's premium funds a purchase's gas, so it is never rate-limited.
  if (kind === "purchase") {
    return sponsorAvailable
      ? { payer: "sarraf", reason: "purchase-exempt" }
      : userPays("sponsor-unavailable");
  }

  // Sponsorship down: the transaction still goes through if the user can pay
  // in hawala. If not, they are blocked, and we say so.
  if (!sponsorAvailable) return userPays("sponsor-unavailable");

  // Rolling 24h, not a calendar day: calendar days need a timezone, and the
  // user's timezone is a thing we would then have to be right about — while a
  // customer near midnight would see two free transfers in a few minutes.
  // Scan the whole history: checking only the most recent entry would re-grant
  // the quota whenever an older sponsorship happened to sort last.
  const usedToday = sponsoredAt.some((t) => now - t < DAY_MS);
  return usedToday
    ? userPays("daily-quota-used")
    : { payer: "sarraf", reason: "daily-free-transfer" };
}
