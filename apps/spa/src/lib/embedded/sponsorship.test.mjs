#!/usr/bin/env node
/**
 * Sponsorship quota — the rule that decides who pays for a transaction.
 *
 * The product promise is that a customer NEVER needs ETH. There are three
 * distinct ways that is honoured, and conflating them is the bug this guards:
 *
 *   · friendly transfer, first of the day  -> the sarraf sponsors it (free)
 *   · friendly transfer, later that day    -> the user pays, in hawala, via the
 *                                             token paymaster (never ETH)
 *   · purchase                             -> always sponsored; the seller's
 *                                             premium is what funds it, so it is
 *                                             exempt from the daily quota
 *
 * Run: node src/lib/embedded/sponsorship.test.mjs
 */
import { decideFunding, DAY_MS } from "./sponsorship.mjs";

let pass = 0;
const failures = [];
const eq = (actual, expected, what) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${what}\n      expected ${e}\n      actual   ${a}`);
};

const T0 = 1_800_000_000_000; // fixed clock; never Date.now() in a test

// ---------------------------------------------------------- friendly transfers

eq(
  decideFunding({ kind: "friendly", sponsoredAt: [], now: T0 }),
  { payer: "sarraf", reason: "daily-free-transfer" },
  "first friendly transfer of the day is sponsored by the sarraf",
);

eq(
  decideFunding({ kind: "friendly", sponsoredAt: [T0], now: T0 + 60_000 }),
  { payer: "user-hawala", reason: "daily-quota-used" },
  "second friendly transfer the same day is paid by the user in hawala",
);

eq(
  decideFunding({ kind: "friendly", sponsoredAt: [T0], now: T0 + DAY_MS + 1 }),
  { payer: "sarraf", reason: "daily-free-transfer" },
  "the quota refreshes once a full day has passed",
);

eq(
  decideFunding({ kind: "friendly", sponsoredAt: [T0], now: T0 + DAY_MS - 1 }),
  { payer: "user-hawala", reason: "daily-quota-used" },
  "one millisecond before the day rolls, the quota is still spent",
);

// History order is not guaranteed. Put the RECENT entry first and an old one
// last: an implementation that inspects only the final element re-grants the
// quota here, which is the bug this case exists to catch. (An earlier version
// of this test listed them sorted, so the bug survived mutation testing.)
eq(
  decideFunding({ kind: "friendly", sponsoredAt: [T0, T0 - 5 * DAY_MS], now: T0 + 60_000 }),
  { payer: "user-hawala", reason: "daily-quota-used" },
  "quota is spent regardless of history ORDER (recent first, stale last)",
);
eq(
  decideFunding({ kind: "friendly", sponsoredAt: [T0 - 5 * DAY_MS, T0], now: T0 + 60_000 }),
  { payer: "user-hawala", reason: "daily-quota-used" },
  "quota is spent regardless of history ORDER (stale first, recent last)",
);
eq(
  decideFunding({ kind: "friendly", sponsoredAt: [T0 - 9 * DAY_MS, T0 - 5 * DAY_MS], now: T0 }),
  { payer: "sarraf", reason: "daily-free-transfer" },
  "a history of only stale sponsorships still grants today's free transfer",
);

// ------------------------------------------------------------------ purchases

eq(
  decideFunding({ kind: "purchase", sponsoredAt: [T0], now: T0 + 60_000 }),
  { payer: "sarraf", reason: "purchase-exempt" },
  "a purchase is sponsored even when the daily transfer quota is spent",
);

eq(
  decideFunding({ kind: "purchase", sponsoredAt: [T0, T0 + 1, T0 + 2], now: T0 + 3 }),
  { payer: "sarraf", reason: "purchase-exempt" },
  "purchases are not rate-limited at all — the seller's premium funds them",
);

// -------------------------------------------------------- the invariant itself

for (const kind of ["friendly", "purchase"]) {
  for (const sponsoredAt of [[], [T0], [T0, T0 + 1, T0 + 2]]) {
    const { payer } = decideFunding({ kind, sponsoredAt, now: T0 + 5 });
    if (payer === "user-eth") {
      failures.push(`INVARIANT VIOLATED: kind=${kind} history=${sponsoredAt.length} demanded ETH`);
    } else pass++;
  }
}

// ------------------------------------------------------------------ degradation

// TWO paymasters, not one. Paying in hawala IS the token paymaster: in
// ERC-4337 the EntryPoint settles gas in ETH, and the only way a user pays in
// an ERC-20 is for a token paymaster to accept it and cover the ETH. So
// "sponsor down, therefore pay in hawala" only holds while the TOKEN paymaster
// is up. An earlier version of this file collapsed both into one flag and
// claimed nobody could ever be stranded, which was simply false.

eq(
  decideFunding({ kind: "friendly", sponsoredAt: [], now: T0, sponsorAvailable: false }),
  { payer: "user-hawala", reason: "sponsor-unavailable" },
  "sponsor down, token paymaster up: the user pays in hawala — still never ETH",
);

eq(
  decideFunding({ kind: "purchase", sponsoredAt: [], now: T0, sponsorAvailable: false }),
  { payer: "user-hawala", reason: "sponsor-unavailable" },
  "even a purchase falls back to the buyer paying if sponsorship is down",
);

eq(
  decideFunding({
    kind: "friendly", sponsoredAt: [], now: T0,
    sponsorAvailable: false, tokenPaymasterAvailable: false,
  }),
  { payer: "none", reason: "no-paymaster" },
  "BOTH paymasters down: honestly blocked — the user has no ETH, so nothing " +
    "can be paid. Naming this is the point; pretending otherwise hid a hole.",
);

eq(
  decideFunding({
    kind: "friendly", sponsoredAt: [T0], now: T0 + 60_000,
    tokenPaymasterAvailable: false,
  }),
  { payer: "none", reason: "no-paymaster" },
  "quota spent and no token paymaster: blocked, not silently charged in ETH",
);

eq(
  decideFunding({
    kind: "purchase", sponsoredAt: [], now: T0, tokenPaymasterAvailable: false,
  }),
  { payer: "sarraf", reason: "purchase-exempt" },
  "a sponsored purchase does not need the token paymaster at all",
);

if (failures.length) {
  console.error(`\nsponsorship: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error("  ✗ " + f);
  console.error("");
  process.exit(1);
}
console.log(`sponsorship: ${pass} assertions passed`);
