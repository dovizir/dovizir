/**
 * Pure derivation logic — no chain, no DB, no I/O.
 *
 * Every function here takes plain decoded events (or synthetic fixtures) and
 * returns derived state. This is the layer the Vitest suite exercises so the
 * money-math (coverage, credit headroom, fee split, TWAB) is provable without
 * a live node.
 *
 * Tranche identity mirrors the on-chain rule: trancheId = uint256(uint160(sarraf)).
 */
import type { Checkpoint, IndexedEvent } from "./types.js";

export const CREDIT_RATE_CAP_BPS = 2000; // 20% — hard clamp on the advisory rate
export const REDEEM_FEE_BPS = 90n; // ReservePool FEE_BPS (0.9%), frozen
export const BPS_DENOMINATOR = 10_000n;
export const FLOOR_CAP = 1_000_000_000_000n; // 1_000_000e6 (SarrafRegistry.FLOOR_CAP)
export const EXIT_BPS = 9_000n; // 90% of floor — decertification band (hysteresis)
export const TWAB_WINDOW = 7 * 24 * 3600; // 7 days, seconds

function lc(a: string | undefined): string {
  return (a ?? "").toLowerCase();
}

/** uint256(uint160(sarraf)) as a decimal string, matching IOU token ids. */
export function trancheIdOf(sarraf: string): string {
  return BigInt(sarraf.toLowerCase()).toString(10);
}

/** Inverse: an IOU token id back to the issuing sarraf address (lowercased). */
export function sarrafOfTranche(id: string): string {
  return ("0x" + BigInt(id).toString(16).padStart(40, "0")).toLowerCase();
}

// ---------------------------------------------------------------- per-sarraf

export interface SarrafBacking {
  /** USDT backing held for the tranche (deposits − redemptions ± migrations). */
  backing: bigint;
  /** IOU liabilities outstanding in the tranche (issued − redeemed ± migrations). */
  outstanding: bigint;
}

/**
 * Net backing + outstanding for one sarraf, reduced from its events.
 * Mirrors ReservePool: deposit/issue add, redeem subtracts from both, migrate
 * moves both between tranches.
 */
export function sarrafBacking(events: IndexedEvent[], sarraf: string): SarrafBacking {
  const s = lc(sarraf);
  let backing = 0n;
  let outstanding = 0n;
  for (const e of events) {
    if (e.contract !== "reservePool") continue;
    switch (e.event) {
      case "Deposited":
        if (lc(e.args.sarraf) === s) backing += BigInt(e.args.amount);
        break;
      case "Issued":
        if (lc(e.args.sarraf) === s) outstanding += BigInt(e.args.amount);
        break;
      case "Redeemed":
        if (lc(e.args.sarraf) === s) {
          backing -= BigInt(e.args.amount);
          outstanding -= BigInt(e.args.amount);
        }
        break;
      case "Migrated": {
        const amt = BigInt(e.args.amount);
        if (lc(e.args.fromSarraf) === s) {
          backing -= amt;
          outstanding -= amt;
        }
        if (lc(e.args.toSarraf) === s) {
          backing += amt;
          outstanding += amt;
        }
        break;
      }
    }
  }
  return { backing, outstanding };
}

/**
 * Coverage ratio = backing / outstanding, as a float for display.
 * Infinity when there are liabilities-free reserves; 1.0 is exactly funded.
 */
export function coverageRatio({ backing, outstanding }: SarrafBacking): number {
  if (outstanding === 0n) return backing === 0n ? 1 : Infinity;
  // Scale to keep 4 decimals of precision through the bigint division.
  return Number((backing * 10_000n) / outstanding) / 10_000;
}

/** Coverage as basis points (10000 = 1.0). Caps display at a large sentinel. */
export function coverageBps({ backing, outstanding }: SarrafBacking): number {
  if (outstanding === 0n) return backing === 0n ? 10_000 : 1_000_000;
  return Number((backing * 10_000n) / outstanding);
}

/**
 * COMPUTED, ADVISORY credit rate (basis points). "Wired but dormant": nothing
 * on-chain reads this — the act-3 CreditOracle write lands later (see README).
 *
 * Model: the share of backing that is free of liabilities is the credit
 * headroom. headroom = (backing − outstanding) / backing, expressed in bps and
 * clamped to [0, 2000]. Fully-reserved-but-idle tranches saturate at the 20%
 * cap; an under-collateralised tranche floors at 0.
 */
export function creditRateBps({ backing, outstanding }: SarrafBacking): number {
  if (backing <= 0n) return 0;
  const free = backing - outstanding;
  if (free <= 0n) return 0;
  const bps = Number((free * 10_000n) / backing);
  return Math.min(CREDIT_RATE_CAP_BPS, Math.max(0, bps));
}

// ------------------------------------------------------------------ fee split

export interface FeeSplit {
  fee: bigint;
  /** maintenance takes fee/2 (rounds down), matching InsuranceFund.recordFee. */
  maintenance: bigint;
  /** overseeing takes the remainder. */
  overseeing: bigint;
}

/** Mirrors InsuranceFund.recordFee: half = fee/2 (down); overseeing = fee − half. */
export function splitFee(fee: bigint): FeeSplit {
  const half = fee / 2n;
  return { fee, maintenance: half, overseeing: fee - half };
}

/** Fee a single redemption sends to the fund (90bps, rounds down). */
export function redeemFee(amount: bigint): bigint {
  return (amount * REDEEM_FEE_BPS) / BPS_DENOMINATOR;
}

// ------------------------------------------------------------------- P&L

export interface SarrafPnl {
  sarraf: string;
  depositVolume: string;
  issuedVolume: string;
  redemptionVolume: string;
  /** Total fees this sarraf's redemptions routed to the fund. */
  feesGenerated: string;
  feeSplit: { maintenance: string; overseeing: string };
  /** Effective fee bps against redemption volume (spread proxy). */
  spreadBps: number;
  redemptionCount: number;
}

/** Act-2 yardstick: profitability instrumentation reduced from a sarraf's events. */
export function sarrafPnl(events: IndexedEvent[], sarraf: string): SarrafPnl {
  const s = lc(sarraf);
  let depositVolume = 0n;
  let issuedVolume = 0n;
  let redemptionVolume = 0n;
  let feesGenerated = 0n;
  let redemptionCount = 0;
  for (const e of events) {
    if (e.contract !== "reservePool") continue;
    if (e.event === "Deposited" && lc(e.args.sarraf) === s) {
      depositVolume += BigInt(e.args.amount);
    } else if (e.event === "Issued" && lc(e.args.sarraf) === s) {
      issuedVolume += BigInt(e.args.amount);
    } else if (e.event === "Redeemed" && lc(e.args.sarraf) === s) {
      redemptionVolume += BigInt(e.args.amount);
      feesGenerated += BigInt(e.args.fee);
      redemptionCount += 1;
    }
  }
  const split = splitFee(feesGenerated);
  const spreadBps =
    redemptionVolume === 0n
      ? 0
      : Number((feesGenerated * 10_000n) / redemptionVolume);
  return {
    sarraf: s,
    depositVolume: depositVolume.toString(),
    issuedVolume: issuedVolume.toString(),
    redemptionVolume: redemptionVolume.toString(),
    feesGenerated: feesGenerated.toString(),
    feeSplit: {
      maintenance: split.maintenance.toString(),
      overseeing: split.overseeing.toString(),
    },
    spreadBps,
    redemptionCount,
  };
}

// ---------------------------------------------------------------- members

/** Set of member addresses homed at a sarraf (MemberAdded/MemberRehomed aware). */
export function membersOf(events: IndexedEvent[], sarraf: string): string[] {
  const s = lc(sarraf);
  const home = new Map<string, string>();
  for (const e of events) {
    if (e.contract !== "memberRegistry") continue;
    if (e.event === "MemberAdded") {
      home.set(lc(e.args.member), lc(e.args.sarraf));
    } else if (e.event === "MemberRehomed") {
      home.set(lc(e.args.member), lc(e.args.toSarraf));
    } else if (e.event === "MemberRemoved") {
      home.delete(lc(e.args.member));
    }
  }
  return [...home.entries()].filter(([, h]) => h === s).map(([m]) => m);
}

/** Latest sponsoring sarraf for a member (undefined if none / removed). */
export function sponsorOf(events: IndexedEvent[], member: string): string | undefined {
  const m = lc(member);
  let sponsor: string | undefined;
  for (const e of events) {
    if (e.contract !== "memberRegistry") continue;
    if (e.event === "MemberAdded" && lc(e.args.member) === m) sponsor = lc(e.args.sarraf);
    else if (e.event === "MemberRehomed" && lc(e.args.member) === m) sponsor = lc(e.args.toSarraf);
    else if (e.event === "MemberRemoved" && lc(e.args.member) === m) sponsor = undefined;
  }
  return sponsor;
}

/** Net IOU balance of a holder in a given tranche, from TransferSingle logs. */
export function memberBalance(events: IndexedEvent[], holder: string, trancheId: string): bigint {
  const h = lc(holder);
  let bal = 0n;
  for (const e of events) {
    if (e.contract !== "iouToken" || e.event !== "TransferSingle") continue;
    if (e.args.id !== trancheId) continue;
    const v = BigInt(e.args.value);
    if (lc(e.args.to) === h) bal += v;
    if (lc(e.args.from) === h) bal -= v;
  }
  return bal;
}

/** All non-zero tranche balances for a holder → { trancheId: balance }. */
export function memberBalances(events: IndexedEvent[], holder: string): Record<string, string> {
  const h = lc(holder);
  const bals = new Map<string, bigint>();
  for (const e of events) {
    if (e.contract !== "iouToken" || e.event !== "TransferSingle") continue;
    const v = BigInt(e.args.value);
    if (lc(e.args.to) === h) bals.set(e.args.id, (bals.get(e.args.id) ?? 0n) + v);
    if (lc(e.args.from) === h) bals.set(e.args.id, (bals.get(e.args.id) ?? 0n) - v);
  }
  const out: Record<string, string> = {};
  for (const [id, bal] of bals) if (bal !== 0n) out[id] = bal.toString();
  return out;
}

// ------------------------------------------------------------------ TWAB + floor

/**
 * Time-weighted average backing over the trailing `window`, from an ordered
 * checkpoint series. Mirrors SarrafRegistry's integral: a constant balance held
 * across the full window returns exactly that balance.
 */
export function twab(
  checkpoints: Checkpoint[],
  now: number,
  window: number = TWAB_WINDOW,
): bigint {
  if (checkpoints.length === 0) return 0n;
  const cps = [...checkpoints].sort((a, b) => a.timestamp - b.timestamp);
  const windowStart = now > window ? now - window : 0;
  const cumEnd = cumulativeAt(cps, now);
  const cumStart = cumulativeAt(cps, windowStart);
  return (cumEnd - cumStart) / BigInt(window);
}

/** ∫ balance·dt from the first checkpoint up to `ts`. */
function cumulativeAt(cps: Checkpoint[], ts: number): bigint {
  if (ts <= cps[0].timestamp) return 0n;
  let cum = 0n;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (cp.timestamp >= ts) break;
    const next = i + 1 < cps.length ? Math.min(cps[i + 1].timestamp, ts) : ts;
    cum += cp.balance * BigInt(next - cp.timestamp);
  }
  return cum;
}

/** Backing checkpoints for a sarraf, ordered by block time. */
export function backingCheckpoints(events: IndexedEvent[], sarraf: string): Checkpoint[] {
  const s = lc(sarraf);
  const cps: Checkpoint[] = [];
  let bal = 0n;
  for (const e of events) {
    if (e.contract !== "reservePool") continue;
    let changed = false;
    if (e.event === "Deposited" && lc(e.args.sarraf) === s) {
      bal += BigInt(e.args.amount);
      changed = true;
    } else if (e.event === "Redeemed" && lc(e.args.sarraf) === s) {
      bal -= BigInt(e.args.amount);
      changed = true;
    } else if (e.event === "Migrated") {
      if (lc(e.args.fromSarraf) === s) {
        bal -= BigInt(e.args.amount);
        changed = true;
      }
      if (lc(e.args.toSarraf) === s) {
        bal += BigInt(e.args.amount);
        changed = true;
      }
    }
    if (changed) cps.push({ timestamp: e.blockTime, balance: bal });
  }
  return cps;
}

/** Cumulative net deposits across all sarrafs (drives the certification floor). */
export function totalDeposits(events: IndexedEvent[]): bigint {
  let total = 0n;
  for (const e of events) {
    if (e.contract !== "reservePool") continue;
    if (e.event === "Deposited") total += BigInt(e.args.amount);
    else if (e.event === "Redeemed") total -= BigInt(e.args.amount);
  }
  return total;
}

/** Certification floor = min(totalDeposits / 5, FLOOR_CAP). */
export function certificationFloor(events: IndexedEvent[]): bigint {
  const fifth = totalDeposits(events) / 5n;
  return fifth < FLOOR_CAP ? fifth : FLOOR_CAP;
}

/** 90%-of-floor decertification band (hysteresis lower edge). */
export function exitFloor(floor: bigint): bigint {
  return (floor * EXIT_BPS) / BPS_DENOMINATOR;
}

export type CertBand = "certified" | "at-risk" | "below-floor";

/**
 * Classify a sarraf against the 100/90 hysteresis bands using its TWAB.
 *  - twab >= floor            → certified (comfortably above the entry line)
 *  - exitFloor <= twab < floor → at-risk (inside the hysteresis band)
 *  - twab < exitFloor          → below-floor (decertification territory)
 */
export function certBand(twabValue: bigint, floor: bigint): CertBand {
  if (twabValue >= floor) return "certified";
  if (twabValue >= exitFloor(floor)) return "at-risk";
  return "below-floor";
}

/** Latest on-chain cert status from Certified/Decertified events. */
export function certStatus(events: IndexedEvent[], sarraf: string): boolean {
  const s = lc(sarraf);
  let certified = false;
  for (const e of events) {
    if (e.contract !== "sarrafRegistry") continue;
    if (lc(e.args.sarraf) !== s) continue;
    if (e.event === "Certified") certified = true;
    else if (e.event === "Decertified") certified = false;
  }
  return certified;
}

// ------------------------------------------------------------- network stats

export interface NetworkStats {
  totalBacking: string;
  totalOutstanding: string;
  totalFees: string;
  claimsPaid: string;
  sarrafCount: number;
  memberCount: number;
  certificationFloor: string;
  coverageBps: number;
}

/** Discover every sarraf that has ever emitted a Deposited event. */
export function knownSarrafs(events: IndexedEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    if (e.contract === "reservePool" && e.event === "Deposited") set.add(lc(e.args.sarraf));
  }
  return [...set];
}

export function networkStats(events: IndexedEvent[]): NetworkStats {
  let totalBacking = 0n;
  let totalOutstanding = 0n;
  let totalFees = 0n;
  let claimsPaid = 0n;
  for (const e of events) {
    if (e.contract === "reservePool") {
      if (e.event === "Deposited") totalBacking += BigInt(e.args.amount);
      else if (e.event === "Issued") totalOutstanding += BigInt(e.args.amount);
      else if (e.event === "Redeemed") {
        totalBacking -= BigInt(e.args.amount);
        totalOutstanding -= BigInt(e.args.amount);
      }
    } else if (e.contract === "insuranceFund" && e.event === "FeeReceived") {
      totalFees += BigInt(e.args.amount);
    } else if (e.contract === "insuranceFund" && e.event === "ClaimPaid") {
      claimsPaid += BigInt(e.args.amount);
    }
  }
  const members = new Set(allMembers(events));
  const floor = certificationFloor(events);
  const cov =
    totalOutstanding === 0n
      ? totalBacking === 0n
        ? 10_000
        : 1_000_000
      : Number((totalBacking * 10_000n) / totalOutstanding);
  return {
    totalBacking: totalBacking.toString(),
    totalOutstanding: totalOutstanding.toString(),
    totalFees: totalFees.toString(),
    claimsPaid: claimsPaid.toString(),
    sarrafCount: knownSarrafs(events).length,
    memberCount: members.size,
    certificationFloor: floor.toString(),
    coverageBps: cov,
  };
}

/** All currently-homed member addresses across every sarraf. */
export function allMembers(events: IndexedEvent[]): string[] {
  const home = new Map<string, string | undefined>();
  for (const e of events) {
    if (e.contract !== "memberRegistry") continue;
    if (e.event === "MemberAdded") home.set(lc(e.args.member), lc(e.args.sarraf));
    else if (e.event === "MemberRehomed") home.set(lc(e.args.member), lc(e.args.toSarraf));
    else if (e.event === "MemberRemoved") home.set(lc(e.args.member), undefined);
  }
  return [...home.entries()].filter(([, h]) => h !== undefined).map(([m]) => m);
}
