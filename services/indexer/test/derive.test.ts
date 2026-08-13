import { describe, it, expect } from "vitest";
import * as d from "../src/derive.js";
import {
  demoLoopEvents,
  SARRAF,
  SARRAF_2,
  MEMBER_A,
  MEMBER_B,
} from "./fixtures.js";
import type { Checkpoint } from "../src/types.js";

describe("tranche identity", () => {
  it("round-trips sarraf ⇄ tranche id (uint160 rule)", () => {
    const id = d.trancheIdOf(SARRAF);
    expect(d.sarrafOfTranche(id)).toBe(SARRAF.toLowerCase());
  });
});

describe("coverage (backing / outstanding)", () => {
  it("nets deposit − redeem for backing and issue − redeem for outstanding", () => {
    const events = demoLoopEvents();
    const b = d.sarrafBacking(events, SARRAF);
    // 1,000,000e6 deposited − 400e6 redeemed
    expect(b.backing).toBe(999_600_000_000n);
    // 1,000e6 issued − 400e6 redeemed
    expect(b.outstanding).toBe(600_000_000n);
  });

  it("coverage ratio = backing / outstanding", () => {
    const b = { backing: 999_600_000_000n, outstanding: 600_000_000n };
    expect(d.coverageRatio(b)).toBeCloseTo(1666, 0);
    expect(d.coverageBps(b)).toBe(16_660_000);
  });

  it("exactly-funded tranche is coverage 1.0", () => {
    expect(d.coverageRatio({ backing: 1000n, outstanding: 1000n })).toBe(1);
    expect(d.coverageBps({ backing: 1000n, outstanding: 1000n })).toBe(10_000);
  });

  it("zero outstanding with backing reads as fully covered, not NaN", () => {
    expect(d.coverageRatio({ backing: 5n, outstanding: 0n })).toBe(Infinity);
    expect(d.coverageRatio({ backing: 0n, outstanding: 0n })).toBe(1);
  });
});

describe("computed creditRateBps (advisory, clamped ≤ 2000)", () => {
  it("clamps a hugely over-collateralised tranche to the 20% cap", () => {
    expect(d.creditRateBps({ backing: 999_600_000_000n, outstanding: 600_000_000n })).toBe(
      d.CREDIT_RATE_CAP_BPS,
    );
  });

  it("scales with headroom below the cap", () => {
    // backing 1000, outstanding 900 → free 100/1000 = 1000 bps (10%)
    expect(d.creditRateBps({ backing: 1000n, outstanding: 900n })).toBe(1000);
    // backing 1000, outstanding 950 → 500 bps (5%)
    expect(d.creditRateBps({ backing: 1000n, outstanding: 950n })).toBe(500);
  });

  it("floors at 0 when fully utilised or under-collateralised", () => {
    expect(d.creditRateBps({ backing: 1000n, outstanding: 1000n })).toBe(0);
    expect(d.creditRateBps({ backing: 1000n, outstanding: 1200n })).toBe(0);
    expect(d.creditRateBps({ backing: 0n, outstanding: 0n })).toBe(0);
  });

  it("never exceeds the cap for any headroom", () => {
    for (const out of [0n, 1n, 100n, 799n, 800n]) {
      expect(d.creditRateBps({ backing: 1000n, outstanding: out })).toBeLessThanOrEqual(2000);
    }
  });
});

describe("fee split accounting", () => {
  it("mirrors InsuranceFund.recordFee: maintenance = fee/2 (down), overseeing = rest", () => {
    const s = d.splitFee(3_600_000n);
    expect(s.maintenance).toBe(1_800_000n);
    expect(s.overseeing).toBe(1_800_000n);
    expect(s.maintenance + s.overseeing).toBe(3_600_000n);
  });

  it("odd fee rounds the extra unit to overseeing", () => {
    const s = d.splitFee(7n);
    expect(s.maintenance).toBe(3n);
    expect(s.overseeing).toBe(4n);
  });

  it("redeemFee is 90bps rounding down", () => {
    expect(d.redeemFee(400_000_000n)).toBe(3_600_000n); // the demo-loop number
    expect(d.redeemFee(199n)).toBe(1n); // 199*90/10000 = 1.79 → 1
  });
});

describe("sarraf P&L (act-2 yardstick)", () => {
  it("attributes fees, redemption volume and spread to the sarraf", () => {
    const pnl = d.sarrafPnl(demoLoopEvents(), SARRAF);
    expect(pnl.depositVolume).toBe("1000000000000");
    expect(pnl.issuedVolume).toBe("1000000000");
    expect(pnl.redemptionVolume).toBe("400000000");
    expect(pnl.feesGenerated).toBe("3600000"); // 3.60 mUSDT
    expect(pnl.feeSplit).toEqual({ maintenance: "1800000", overseeing: "1800000" });
    expect(pnl.spreadBps).toBe(90); // effective 0.9%
    expect(pnl.redemptionCount).toBe(1);
  });

  it("is empty for an unrelated sarraf", () => {
    const pnl = d.sarrafPnl(demoLoopEvents(), SARRAF_2);
    expect(pnl.feesGenerated).toBe("0");
    expect(pnl.spreadBps).toBe(0);
  });
});

describe("members and balances", () => {
  it("resolves membership and sponsor from registry events", () => {
    const events = demoLoopEvents();
    expect(d.membersOf(events, SARRAF).sort()).toEqual([MEMBER_A, MEMBER_B].sort());
    expect(d.sponsorOf(events, MEMBER_A)).toBe(SARRAF);
  });

  it("nets IOU balances from TransferSingle logs", () => {
    const events = demoLoopEvents();
    const tranche = d.trancheIdOf(SARRAF);
    // A: +1000 issued − 400 sent = 600
    expect(d.memberBalance(events, MEMBER_A, tranche)).toBe(600_000_000n);
    // B: +400 received − 400 redeemed = 0
    expect(d.memberBalance(events, MEMBER_B, tranche)).toBe(0n);
  });

  it("rehoming moves the member to the new sarraf", () => {
    const events = demoLoopEvents();
    events.push({
      contract: "memberRegistry",
      event: "MemberRehomed",
      blockNumber: 999,
      blockTime: 99_999,
      logIndex: 0,
      txHash: "0xrehome",
      args: { member: MEMBER_A, fromSarraf: SARRAF, toSarraf: SARRAF_2 },
    });
    expect(d.sponsorOf(events, MEMBER_A)).toBe(SARRAF_2);
    expect(d.membersOf(events, SARRAF)).not.toContain(MEMBER_A);
    expect(d.membersOf(events, SARRAF_2)).toContain(MEMBER_A);
  });
});

describe("certification floor + TWAB hysteresis bands", () => {
  it("floor = min(totalDeposits/5, cap)", () => {
    const events = demoLoopEvents();
    // net deposits = 999_600e6 → /5 = 199_920e6, under the 1M cap
    expect(d.certificationFloor(events)).toBe(199_920_000_000n);
  });

  it("caps the floor at 1M when a fifth of deposits exceeds it", () => {
    const events = [
      {
        contract: "reservePool" as const,
        event: "Deposited",
        blockNumber: 1,
        blockTime: 0,
        logIndex: 0,
        txHash: "0xa",
        args: { sarraf: SARRAF, amount: (10_000_000_000_000n).toString() }, // 10M
      },
    ];
    expect(d.certificationFloor(events)).toBe(d.FLOOR_CAP);
  });

  it("constant balance held across the window yields exactly that balance (TWAB)", () => {
    const cps: Checkpoint[] = [{ timestamp: 0, balance: 1_000_000n }];
    // now well past a full window with a single constant checkpoint
    expect(d.twab(cps, 30 * 24 * 3600)).toBe(1_000_000n);
  });

  it("classifies the 100/90 hysteresis bands", () => {
    const floor = 1_000_000n;
    expect(d.certBand(1_000_000n, floor)).toBe("certified"); // == floor
    expect(d.certBand(1_200_000n, floor)).toBe("certified");
    expect(d.certBand(950_000n, floor)).toBe("at-risk"); // between 90% and 100%
    expect(d.certBand(900_000n, floor)).toBe("at-risk"); // == exit edge
    expect(d.certBand(899_999n, floor)).toBe("below-floor");
    expect(d.exitFloor(floor)).toBe(900_000n);
  });

  it("tracks on-chain cert status from Certified/Decertified", () => {
    const events = demoLoopEvents();
    expect(d.certStatus(events, SARRAF)).toBe(true);
    events.push({
      contract: "sarrafRegistry",
      event: "Decertified",
      blockNumber: 999,
      blockTime: 0,
      logIndex: 0,
      txHash: "0xd",
      args: { sarraf: SARRAF },
    });
    expect(d.certStatus(events, SARRAF)).toBe(false);
  });
});

describe("network stats", () => {
  it("aggregates totals, fees and the sarraf/member counts", () => {
    const s = d.networkStats(demoLoopEvents());
    expect(s.totalBacking).toBe("999600000000");
    expect(s.totalOutstanding).toBe("600000000");
    expect(s.totalFees).toBe("3600000");
    expect(s.sarrafCount).toBe(1);
    expect(s.memberCount).toBe(2);
  });
});
