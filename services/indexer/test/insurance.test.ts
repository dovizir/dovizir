/**
 * The sarraf's insurance position, derived from PurchaseInsurance events.
 *
 * Why this matters beyond arithmetic: the desk is the screen that sells the
 * model to a money-changer. Bonds under management, premium earned, and what
 * they can actually withdraw ARE the "what's in it for you" answer. Until the
 * indexer reads these events, none of it is visible.
 */
import { describe, it, expect } from "vitest";
import { sarrafInsurance, RESERVE_RATIO_BPS } from "../src/insurance.js";
import type { IndexedEvent } from "../src/types.js";

const SARRAF = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const OTHER = "0x976ea74026e726554db657fa54763abd0c3a0aa9";
const SHOP_A = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const SHOP_B = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";

let seq = 0;
const ev = (event: string, args: Record<string, string>): IndexedEvent => ({
  contract: "purchaseInsurance",
  event,
  blockNumber: 100 + seq,
  blockTime: 1_000 + seq * 60,
  logIndex: 0,
  txHash: `0x${(++seq).toString(16).padStart(64, "0")}`,
  args,
});

const registered = (shop: string, sarraf = SARRAF, bond = "10000000000") =>
  ev("ShopRegistered", { shop, sarraf, bond, trustBps: "10000" });
/** premium is split 50/50; the odd wei goes to the sarraf's layer.
 *  The id is explicit: deriving it from the fixture counter silently
 *  de-synced it from the events that later reference the purchase. */
const purchase = (shop: string, amount: string, premium: string, purchaseId = "1") =>
  ev("PurchaseRecorded", { purchaseId, shop, buyer: OTHER, amount, premium });

describe("sarrafInsurance", () => {
  it("is all zeros for a sarraf with no shops", () => {
    const p = sarrafInsurance([], SARRAF);
    expect(p).toEqual({
      bondsUnderManagement: 0n,
      shopCount: 0,
      unearned: 0n,
      earned: 0n,
      outstandingExposure: 0n,
      withdrawable: 0n,
      strikes: 0,
    });
  });

  it("counts bonds only for shops this sarraf underwrote", () => {
    const p = sarrafInsurance(
      [registered(SHOP_A), registered(SHOP_B, OTHER, "5000000000")],
      SARRAF,
    );
    expect(p.bondsUnderManagement).toBe(10_000_000_000n);
    expect(p.shopCount).toBe(1);
  });

  it("credits the sarraf's half of a premium as unearned, and tracks exposure", () => {
    const p = sarrafInsurance(
      [registered(SHOP_A), purchase(SHOP_A, "1000000000", "9000000")],
      SARRAF,
    );
    // 9_000_000 premium -> half 4_500_000 each; odd wei would go to the sarraf.
    expect(p.unearned).toBe(4_500_000n);
    expect(p.earned).toBe(0n);
    expect(p.outstandingExposure).toBe(1_000_000_000n);
  });

  it("moves unearned to earned when coverage closes, and releases exposure", () => {
    const evs = [
      registered(SHOP_A),
      purchase(SHOP_A, "1000000000", "9000000"),
      ev("PremiumEarned", { purchaseId: "1", sarraf: SARRAF, premium: "9000000" }),
    ];
    const p = sarrafInsurance(evs, SARRAF);
    expect(p.unearned).toBe(0n);
    expect(p.earned).toBe(4_500_000n);
    expect(p.outstandingExposure).toBe(0n);
  });

  it("withholds a cushion against live exposure — earned is not all withdrawable", () => {
    const evs = [registered(SHOP_A), purchase(SHOP_A, "1000000000", "9000000")];
    const p = sarrafInsurance(evs, SARRAF);
    // cushion = 10% of 1_000_000_000 = 100_000_000 > earned 0 -> nothing free
    expect(p.withdrawable).toBe(0n);
    expect(RESERVE_RATIO_BPS).toBe(1_000);
  });

  it("frees the earned surplus once exposure is released", () => {
    const evs = [
      registered(SHOP_A),
      purchase(SHOP_A, "1000000000", "9000000"),
      ev("PremiumEarned", { purchaseId: "1", sarraf: SARRAF, premium: "9000000" }),
    ];
    expect(sarrafInsurance(evs, SARRAF).withdrawable).toBe(4_500_000n);
  });

  it("a loss that reaches the sarraf's layer drains it and records a strike", () => {
    const evs = [
      registered(SHOP_A),
      purchase(SHOP_A, "1000000000", "9000000"),
      ev("LossAbsorbed", {
        shop: SHOP_A,
        fromBond: "900000000",
        fromSarraf: "4500000",
        fromMaintainer: "95500000",
      }),
      ev("SarrafStrike", { sarraf: SARRAF, strikes: "1" }),
    ];
    const p = sarrafInsurance(evs, SARRAF);
    expect(p.unearned).toBe(0n);
    expect(p.strikes).toBe(1);
    expect(p.bondsUnderManagement).toBe(10_000_000_000n - 900_000_000n);
  });

  it("bond top-ups and releases move bonds under management", () => {
    const evs = [
      registered(SHOP_A),
      ev("BondToppedUp", { shop: SHOP_A, from: OTHER, amount: "500000000" }),
      ev("BondReleased", { shop: SHOP_A, to: SARRAF, amount: "200000000" }),
    ];
    expect(sarrafInsurance(evs, SARRAF).bondsUnderManagement).toBe(
      10_000_000_000n + 500_000_000n - 200_000_000n,
    );
  });

  it("a withdrawal reduces the earned balance", () => {
    const evs = [
      registered(SHOP_A),
      purchase(SHOP_A, "1000000000", "9000000"),
      ev("PremiumEarned", { purchaseId: "1", sarraf: SARRAF, premium: "9000000" }),
      ev("Withdrawn", { layer: SARRAF, amount: "1000000" }),
    ];
    expect(sarrafInsurance(evs, SARRAF).earned).toBe(3_500_000n);
  });

  it("a maintainer penalty is taken from earned", () => {
    const evs = [
      registered(SHOP_A),
      purchase(SHOP_A, "1000000000", "9000000"),
      ev("PremiumEarned", { purchaseId: "1", sarraf: SARRAF, premium: "9000000" }),
      ev("SarrafPenalized", { sarraf: SARRAF, amount: "500000" }),
    ];
    expect(sarrafInsurance(evs, SARRAF).earned).toBe(4_000_000n);
  });

  it("never attributes another sarraf's activity — layers are not pooled", () => {
    const evs = [
      registered(SHOP_A, OTHER),
      purchase(SHOP_A, "1000000000", "9000000"),
      ev("SarrafStrike", { sarraf: OTHER, strikes: "3" }),
      ev("Withdrawn", { layer: OTHER, amount: "1000000" }),
    ];
    const p = sarrafInsurance(evs, SARRAF);
    expect(p).toEqual({
      bondsUnderManagement: 0n,
      shopCount: 0,
      unearned: 0n,
      earned: 0n,
      outstandingExposure: 0n,
      withdrawable: 0n,
      strikes: 0,
    });
  });

  it("ignores events from other contracts", () => {
    const foreign: IndexedEvent = {
      contract: "reservePool",
      event: "Issued",
      blockNumber: 1,
      blockTime: 1,
      logIndex: 0,
      txHash: "0x0",
      args: { sarraf: SARRAF, amount: "999" },
    };
    expect(sarrafInsurance([foreign], SARRAF).unearned).toBe(0n);
  });

  // These two paths were found while implementing, not while writing the tests:
  // coverage closes via FOUR events, and every one must release exposure or the
  // desk's number drifts up forever and understates what can be withdrawn.

  it("buyer confirmation at the counter closes coverage and earns the premium", () => {
    const evs = [
      registered(SHOP_A),
      purchase(SHOP_A, "1000000000", "9000000"),
      ev("ReceiptConfirmed", { purchaseId: "1", buyer: OTHER }),
    ];
    const p = sarrafInsurance(evs, SARRAF);
    expect(p.outstandingExposure).toBe(0n);
    expect(p.earned).toBe(4_500_000n);
    expect(p.unearned).toBe(0n);
  });

  it("a rejected claim closes coverage and earns the premium", () => {
    const evs = [
      registered(SHOP_A),
      purchase(SHOP_A, "1000000000", "9000000"),
      ev("ClaimRuled", { purchaseId: "1", upheld: "false", paid: "0" }),
    ];
    const p = sarrafInsurance(evs, SARRAF);
    expect(p.outstandingExposure).toBe(0n);
    expect(p.earned).toBe(4_500_000n);
  });

  it("an upheld claim releases exposure but earns nothing", () => {
    const evs = [
      registered(SHOP_A),
      purchase(SHOP_A, "1000000000", "9000000"),
      ev("ClaimRuled", { purchaseId: "1", upheld: "true", paid: "1000000000" }),
    ];
    const p = sarrafInsurance(evs, SARRAF);
    expect(p.outstandingExposure).toBe(0n);
    expect(p.earned).toBe(0n);
  });

  it("exposure is released exactly once, even if events repeat", () => {
    const evs = [
      registered(SHOP_A),
      purchase(SHOP_A, "1000000000", "9000000"),
      ev("PremiumEarned", { purchaseId: "1", sarraf: SARRAF, premium: "9000000" }),
      ev("PremiumEarned", { purchaseId: "1", sarraf: SARRAF, premium: "9000000" }),
    ];
    expect(sarrafInsurance(evs, SARRAF).outstandingExposure).toBe(0n);
  });
});
