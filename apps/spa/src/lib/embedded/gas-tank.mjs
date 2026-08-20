/**
 * The sarraf's prepaid gas tank (mvp.md "Gas billing", decided 2026-08-20).
 *
 * One Pimlico account — the maintainer's — fronts all gas in ETH. Each sarraf
 * prepays a tank in USDT; every sponsored transaction attributed to their
 * customers draws it down AT COST: the tank loses exactly what the maintainer
 * paid, converted at the rate recorded on that debit. No margin ("any future
 * margin is a governance question, not a pilot one").
 *
 * The tank is also the degradation switch: an empty tank flips
 * `sponsorAvailable` for that sarraf alone, routing their users to
 * pay-in-hawala via the token paymaster (see sponsorship.mjs). Billing and
 * fallback are one mechanism, so they cannot disagree.
 *
 * Pure reducer over events, like sarrafInsurance in the indexer: the desk can
 * never disagree with the ledger it renders.
 */

/** Runway (days) at which the desk warns — before exhaustion, not at it. */
export const LOW_TANK_DAYS = 3;

/** Trailing window over which burn rate is measured. */
const BURN_WINDOW_MS = 7 * 86_400_000;

const WEI_PER_ETH = 1_000_000_000_000_000_000n;

/**
 * Reduce top-up / sponsorship events into per-sarraf tanks.
 *
 * @param {Array<
 *   | {kind:"topUp", sarraf:string, usdt:number, at?:number}
 *   | {kind:"sponsor", sarraf:string, gasWei:bigint, ethUsdtRate:number, at?:number}
 * >} events
 * @returns {Record<string, {balanceUsdt:number, debits:Array<{usdt:number, gasWei:bigint, ethUsdtRate:number, at:number}>}>}
 */
export function tankLedger(events) {
  /** @type {Record<string, {balanceUsdt:number, debits:any[]}>} */
  const tanks = {};
  const tank = (s) => (tanks[s] ??= { balanceUsdt: 0, owedUsdt: 0, debits: [] });

  for (const e of events) {
    if (e.kind === "topUp") {
      const t = tank(e.sarraf);
      // Arrears settle first: the maintainer already paid that ETH.
      const toOwed = Math.min(t.owedUsdt, e.usdt);
      t.owedUsdt = round6(t.owedUsdt - toOwed);
      t.balanceUsdt = round6(t.balanceUsdt + (e.usdt - toOwed));
    } else if (e.kind === "sponsor") {
      const t = tank(e.sarraf);
      // At cost: actual gas at the rate recorded when it was paid. The rate
      // travels with the debit so the ledger is auditable after rates move.
      const usdt = round6((Number(e.gasWei) / Number(WEI_PER_ETH)) * e.ethUsdtRate);
      // A sponsorship can land on an empty tank (a userop in flight when it
      // hit zero). The maintainer has already paid, so the shortfall cannot
      // vanish — but a silently negative balance is not a display model.
      // Balance floors at zero; the remainder is explicit arrears.
      const fromBalance = Math.min(t.balanceUsdt, usdt);
      t.balanceUsdt = round6(t.balanceUsdt - fromBalance);
      t.owedUsdt = round6(t.owedUsdt + (usdt - fromBalance));
      t.debits.push({ usdt, gasWei: e.gasWei, ethUsdtRate: e.ethUsdtRate, at: e.at ?? 0 });
    }
  }
  return tanks;
}

/**
 * What the desk shows, and what decideFunding consumes.
 *
 * @param {{balanceUsdt:number, debits:Array<{usdt:number, at:number}>}|undefined} tank
 * @param {number} now epoch-ms; passed in, never read from the clock
 */
export function tankView(tank, now) {
  const balanceUsdt = round6(tank?.balanceUsdt ?? 0);
  const debits = tank?.debits ?? [];

  const windowStart = now - BURN_WINDOW_MS;
  // >= on the boundary: a debit exactly window-age ago still counts, so
  // "7 sponsorships over 7 days" reads as 3/day, not 6 sevenths of it.
  const recent = debits.filter((d) => d.at >= windowStart && d.at <= now);
  const spent = recent.reduce((t, d) => t + d.usdt, 0);
  // Burn over the trailing window, prorated to a day.
  const burnPerDayUsdt = round6(spent / (BURN_WINDOW_MS / 86_400_000));

  const daysRemaining =
    burnPerDayUsdt > 0 ? Math.floor(balanceUsdt / burnPerDayUsdt) : null;

  return {
    balanceUsdt,
    /** Debt to the maintainer from sponsorships that landed on an empty tank. */
    owedUsdt: round6(tank?.owedUsdt ?? 0),
    burnPerDayUsdt,
    /** null when there is no burn: "no projection" is honest, Infinity is not. */
    daysRemaining,
    /** The warning fires while there is still runway to act on it. */
    low: daysRemaining !== null && daysRemaining <= LOW_TANK_DAYS,
    /** The degradation switch, per sarraf: empty tank -> their users pay in
     *  hawala. Low does NOT flip this — a warning is not an outage. */
    sponsorAvailable: balanceUsdt > 0,
  };
}

/** Float hygiene at USDT's 6 decimals, the token's own precision. */
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
