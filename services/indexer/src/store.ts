/**
 * Read model: turns the persisted event log into the JSON the API and the desk
 * consume. All heavy lifting delegates to the pure functions in derive.ts.
 */
import { allEvents, type DB } from "./db.js";
import * as d from "./derive.js";
import type { IndexedEvent } from "./types.js";

export interface SarrafView {
  sarraf: string;
  trancheId: string;
  backing: string;
  outstanding: string;
  coverageBps: number;
  coverageRatio: number;
  /** COMPUTED, advisory credit rate — dormant (nothing enforces it). See README. */
  creditRateBps: number;
  creditRateAdvisory: true;
  certifiedOnChain: boolean;
  twab: string;
  certificationFloor: string;
  exitFloor: string;
  certBand: d.CertBand;
  memberCount: number;
  members: string[];
  pnl: d.SarrafPnl;
  lastEventBlock: number;
}

export function sarrafView(events: IndexedEvent[], sarraf: string, now: number): SarrafView {
  const backing = d.sarrafBacking(events, sarraf);
  const floor = d.certificationFloor(events);
  // TWAB reference clock: the later of wall-clock and the latest block time. On
  // a time-warped dev chain (anvil evm_increaseTime) block time runs ahead of
  // wall-clock, so the block clock is authoritative; on a real chain the two
  // coincide, and a genuinely idle chain lets wall-clock extend the last
  // balance forward (correct decay behaviour).
  const latestBlockTime = events.length ? events[events.length - 1].blockTime : now;
  const twabNow = Math.max(now, latestBlockTime);
  const twabValue = d.twab(d.backingCheckpoints(events, sarraf), twabNow);
  const members = d.membersOf(events, sarraf);
  const lastBlock = events.length ? events[events.length - 1].blockNumber : 0;
  return {
    sarraf: sarraf.toLowerCase(),
    trancheId: d.trancheIdOf(sarraf),
    backing: backing.backing.toString(),
    outstanding: backing.outstanding.toString(),
    coverageBps: d.coverageBps(backing),
    coverageRatio: d.coverageRatio(backing),
    creditRateBps: d.creditRateBps(backing),
    creditRateAdvisory: true,
    certifiedOnChain: d.certStatus(events, sarraf),
    twab: twabValue.toString(),
    certificationFloor: floor.toString(),
    exitFloor: d.exitFloor(floor).toString(),
    certBand: d.certBand(twabValue, floor),
    memberCount: members.length,
    members,
    pnl: d.sarrafPnl(events, sarraf),
    lastEventBlock: lastBlock,
  };
}

export interface MemberView {
  member: string;
  sponsor?: string;
  balances: Record<string, string>;
  totalBalance: string;
  history: Array<{
    txHash: string;
    blockNumber: number;
    blockTime: number;
    direction: "in" | "out";
    counterparty: string;
    trancheId: string;
    amount: string;
  }>;
}

export function memberView(events: IndexedEvent[], member: string): MemberView {
  const m = member.toLowerCase();
  const balances = d.memberBalances(events, member);
  let total = 0n;
  for (const v of Object.values(balances)) total += BigInt(v);
  const history: MemberView["history"] = [];
  for (const e of events) {
    if (e.contract !== "iouToken" || e.event !== "TransferSingle") continue;
    const from = (e.args.from ?? "").toLowerCase();
    const to = (e.args.to ?? "").toLowerCase();
    if (from !== m && to !== m) continue;
    history.push({
      txHash: e.txHash,
      blockNumber: e.blockNumber,
      blockTime: e.blockTime,
      direction: to === m ? "in" : "out",
      counterparty: to === m ? from : to,
      trancheId: e.args.id,
      amount: e.args.value,
    });
  }
  return {
    member: m,
    sponsor: d.sponsorOf(events, member),
    balances,
    totalBalance: total.toString(),
    history,
  };
}

export interface Snapshot {
  chainHeadBlock: number;
  eventCount: number;
  stats: d.NetworkStats;
  sarrafs: SarrafView[];
}

/** The desk's one-shot payload: network stats + every known sarraf's book. */
export function snapshot(db: DB, now: number): Snapshot {
  const events = allEvents(db);
  const sarrafs = d.knownSarrafs(events).map((s) => sarrafView(events, s, now));
  const lastBlock = events.length ? events[events.length - 1].blockNumber : 0;
  return {
    chainHeadBlock: lastBlock,
    eventCount: events.length,
    stats: d.networkStats(events),
    sarrafs,
  };
}
