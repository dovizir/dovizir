#!/usr/bin/env node
/**
 * The sarraf's prepaid gas tank — the billing surface of the at-cost
 * sponsorship model (mvp.md "Gas billing", decided 2026-08-20).
 *
 * The invariants under test, in order of how expensive they are to get wrong:
 *   1. attribution — sarraf A's customers never draw sarraf B's tank
 *   2. at-cost — the tank loses exactly what the maintainer paid, no margin
 *   3. degradation — an empty tank flips sponsorAvailable for THAT sarraf only,
 *      which routes their users to pay-in-hawala instead of stranding them
 *   4. the low warning fires BEFORE exhaustion, not after
 *
 * Run: node src/lib/embedded/gas-tank.test.mjs
 */
import { tankLedger, tankView, LOW_TANK_DAYS } from "./gas-tank.mjs";

let pass = 0;
const failures = [];
const eq = (a, e, what) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++;
  else failures.push(`${what}\n      expected ${E}\n      actual   ${A}`);
};
const ok = (c, what) => (c ? pass++ : failures.push(what));

const A = "0xaaaa", B = "0xbbbb";
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

/** events: topUp {sarraf, usdt} | sponsor {sarraf, gasWei, ethUsdtRate, at} */
const topUp = (sarraf, usdt, at = T0) => ({ kind: "topUp", sarraf, usdt, at });
const sponsor = (sarraf, gasWei, ethUsdtRate, at = T0) => ({
  kind: "sponsor", sarraf, gasWei, ethUsdtRate, at,
});

// gas cost helper: 1e15 wei (0.001 ETH) at rate 3000 USDT/ETH = 3 USDT
const GAS = 1_000_000_000_000_000n;
const RATE = 3000;

// ------------------------------------------------------------- attribution

{
  const l = tankLedger([topUp(A, 100), topUp(B, 50), sponsor(A, GAS, RATE)]);
  eq(l[A].balanceUsdt, 97, "sarraf A's tank drew for A's sponsorship");
  eq(l[B].balanceUsdt, 50, "sarraf B's tank is untouched by A's customers");
}

{
  const l = tankLedger([topUp(A, 10), sponsor(B, GAS, RATE)]);
  eq(l[A].balanceUsdt, 10, "a sponsorship for B never reaches A's tank");
  eq(l[B].balanceUsdt, 0, "B without a top-up floors at zero, never silently negative");
  eq(l[B].owedUsdt, 3, "the maintainer already paid that ETH: the shortfall is explicit arrears");
}

// --------------------------------------------------------------- arrears

{
  // In-flight race: the tank empties mid-day, one more sponsorship lands.
  const l = tankLedger([topUp(A, 4), sponsor(A, GAS, RATE), sponsor(A, GAS, RATE)]);
  eq(l[A].balanceUsdt, 0, "second draw exhausts the tank");
  eq(l[A].owedUsdt, 2, "and the uncovered remainder becomes arrears (3+3 vs 4)");
}

{
  // A top-up settles arrears before it refills the tank.
  const l = tankLedger([
    topUp(A, 3), sponsor(A, GAS, RATE), sponsor(A, GAS, RATE), // owed 3
    topUp(A, 10),
  ]);
  eq(l[A].owedUsdt, 0, "arrears settle first from a top-up");
  eq(l[A].balanceUsdt, 7, "only the remainder refills the tank");
}

// ----------------------------------------------------------------- at-cost

{
  const l = tankLedger([topUp(A, 100), sponsor(A, GAS, RATE)]);
  // 0.001 ETH * 3000 = 3 USDT: the tank loses exactly the maintainer's cost.
  eq(l[A].balanceUsdt, 97, "draw equals actual gas at the recorded rate — no margin");
  eq(l[A].debits.length, 1, "each draw is a ledger entry");
  eq(l[A].debits[0].ethUsdtRate, RATE, "the rate used is stored with the debit (auditable)");
}

{
  // Same gas, different recorded rate -> different USDT: rate is per-debit,
  // never a global assumption.
  const l = tankLedger([topUp(A, 100), sponsor(A, GAS, 2000, T0), sponsor(A, GAS, 4000, T0 + 1)]);
  eq(l[A].balanceUsdt, 94, "each debit converts at its own recorded rate (2 + 4)");
}

// -------------------------------------------------------------- degradation

{
  const l = tankLedger([topUp(A, 3), sponsor(A, GAS, RATE)]);
  eq(l[A].balanceUsdt, 0, "tank can reach exactly zero");
  eq(tankView(l[A], T0).sponsorAvailable, false, "zero tank -> sponsorship off for this sarraf");
}

{
  const l = tankLedger([topUp(A, 3), sponsor(A, GAS, RATE), topUp(A, 10, T0 + 1)]);
  eq(tankView(l[A], T0 + 1).sponsorAvailable, true, "topping up restores sponsorship, nothing else needed");
}

{
  const l = tankLedger([topUp(A, 100), sponsor(A, GAS, RATE), topUp(B, 1)]);
  ok(tankView(l[A], T0).sponsorAvailable === true, "A stays available");
  // B has 1 USDT: available until it drains — per-sarraf state, never global.
  ok(tankView(l[B], T0).sponsorAvailable === true, "B's availability is B's own");
}

// ------------------------------------------------- burn, projection, warning

{
  // 7 sponsorships of 3 USDT over 7 days -> burn 3/day, 79 USDT left -> ~26 days
  const evs = [topUp(A, 100)];
  for (let d = 0; d < 7; d++) evs.push(sponsor(A, GAS, RATE, T0 + d * DAY));
  const v = tankView(tankLedger(evs)[A], T0 + 7 * DAY);
  eq(v.burnPerDayUsdt, 3, "burn rate from the trailing window");
  eq(v.daysRemaining, 26, "projection = balance / burn, floored");
  eq(v.low, false, "26 days out is not low");
}

{
  // same burn, nearly empty -> low fires while days remain, not at zero
  const evs = [topUp(A, 100)];
  for (let d = 0; d < 32; d++) evs.push(sponsor(A, GAS, RATE, T0 + d * DAY));
  const v = tankView(tankLedger(evs)[A], T0 + 32 * DAY);
  eq(v.balanceUsdt, 4, "4 USDT left");
  eq(v.daysRemaining, 1, "about a day of runway");
  ok(v.low === true, `low warning fires with runway <= ${LOW_TANK_DAYS} days — BEFORE exhaustion`);
  ok(v.sponsorAvailable === true, "low is a warning; sponsorship still on until actually empty");
}

{
  const v = tankView(tankLedger([topUp(A, 100)])[A], T0);
  eq(v.burnPerDayUsdt, 0, "no sponsorships yet -> zero burn");
  eq(v.daysRemaining, null, "no burn -> no projection, rather than Infinity theatre");
  eq(v.low, false, "a full idle tank is not low");
}

if (failures.length) {
  console.error(`\ngas-tank: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error("  ✗ " + f);
  console.error("");
  process.exit(1);
}
console.log(`gas-tank: ${pass} assertions passed`);
