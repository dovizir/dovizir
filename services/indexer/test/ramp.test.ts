import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildFirmQuoteTypedData,
  buildIndicativeRateTypedData,
  randomQuoteId,
  verifyFirmQuote,
  verifyIndicativeRate,
  type FirmQuote,
  type IndicativeRate,
} from "@dovizir/sdk";
import {
  allowedEvents,
  applyOrderEvent,
  canApply,
  IllegalTransitionError,
  ManualFiatVerifier,
  TERMINAL_STATUSES,
} from "../src/ramp.js";

// anvil account #1 (the demo Sarraf) — deterministic key.
const SARRAF_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const sarrafAccount = privateKeyToAccount(SARRAF_KEY);
const CUSTOMER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const CHAIN_ID = 84532;

describe("order state machine — on-ramp (fiat → IOU)", () => {
  it("drives the happy path OPEN → QUOTED → FIAT_CLAIMED → SETTLED", () => {
    let s = applyOrderEvent("on-ramp", "OPEN", "ACCEPT_QUOTE");
    expect(s).toBe("QUOTED");
    s = applyOrderEvent("on-ramp", s, "UPLOAD_RECEIPT");
    expect(s).toBe("FIAT_CLAIMED");
    s = applyOrderEvent("on-ramp", s, "ISSUE_CONFIRMED");
    expect(s).toBe("SETTLED");
    expect(TERMINAL_STATUSES.has(s)).toBe(true);
  });

  it("rejects an out-of-order receipt before acceptance", () => {
    expect(() => applyOrderEvent("on-ramp", "OPEN", "UPLOAD_RECEIPT")).toThrow(
      IllegalTransitionError,
    );
  });

  it("cannot confirm issuance before the fiat receipt is claimed", () => {
    expect(() => applyOrderEvent("on-ramp", "QUOTED", "ISSUE_CONFIRMED")).toThrow(
      IllegalTransitionError,
    );
  });

  it("cannot take the off-ramp IOU_SENT path on an on-ramp order", () => {
    expect(() => applyOrderEvent("on-ramp", "QUOTED", "IOU_SENT")).toThrow(
      IllegalTransitionError,
    );
  });
});

describe("order state machine — off-ramp (IOU → fiat)", () => {
  it("drives the happy path OPEN → QUOTED → IOU_SENT → SETTLED", () => {
    let s = applyOrderEvent("off-ramp", "OPEN", "ACCEPT_QUOTE");
    expect(s).toBe("QUOTED");
    s = applyOrderEvent("off-ramp", s, "IOU_SENT");
    expect(s).toBe("IOU_SENT");
    s = applyOrderEvent("off-ramp", s, "PAY_FIAT_RECEIPT");
    expect(s).toBe("SETTLED");
  });

  it("cannot pay fiat before the customer sent IOU", () => {
    expect(() => applyOrderEvent("off-ramp", "QUOTED", "PAY_FIAT_RECEIPT")).toThrow(
      IllegalTransitionError,
    );
  });
});

describe("order state machine — rejection + guards", () => {
  it("can REJECT from any non-terminal state", () => {
    expect(applyOrderEvent("on-ramp", "OPEN", "REJECT")).toBe("REJECTED");
    expect(applyOrderEvent("on-ramp", "QUOTED", "REJECT")).toBe("REJECTED");
    expect(applyOrderEvent("off-ramp", "IOU_SENT", "REJECT")).toBe("REJECTED");
  });

  it("has no transitions out of terminal states", () => {
    expect(allowedEvents("on-ramp", "SETTLED")).toEqual([]);
    expect(allowedEvents("on-ramp", "REJECTED")).toEqual([]);
    expect(canApply("on-ramp", "SETTLED", "REJECT")).toBe(false);
  });

  it("exposes the legal next events per state", () => {
    expect(allowedEvents("on-ramp", "QUOTED").sort()).toEqual(["REJECT", "UPLOAD_RECEIPT"]);
    expect(allowedEvents("off-ramp", "QUOTED").sort()).toEqual(["IOU_SENT", "REJECT"]);
  });
});

describe("ManualFiatVerifier (IFiatVerifier seam)", () => {
  const verifier = new ManualFiatVerifier();

  it("passes when a receipt hash anchor exists", async () => {
    const v = await verifier.verify({
      direction: "on-ramp",
      fiat: "IRR",
      fiatAmount: "1000000000",
      receiptHash: "0x" + "ab".repeat(32),
      receiptMime: "image/png",
    });
    expect(v.ok).toBe(true);
    expect(v.method).toBe("manual");
  });

  it("fails with no evidence on file", async () => {
    const v = await verifier.verify({
      direction: "on-ramp",
      fiat: "IRR",
      fiatAmount: "1000000000",
      receiptHash: "",
      receiptMime: "",
    });
    expect(v.ok).toBe(false);
  });
});

describe("IndicativeRate EIP-712 sign/verify", () => {
  const rate: IndicativeRate = {
    sarraf: sarrafAccount.address,
    fiat: "IRR",
    buyRate: "590000",
    sellRate: "605000",
    minUsdt: "10",
    maxUsdt: "50000",
    effectiveFrom: 1_700_000_000n,
    nonce: 1n,
  };

  it("verifies a Sarraf-signed board rate", async () => {
    const sig = await sarrafAccount.signTypedData(buildIndicativeRateTypedData(rate, CHAIN_ID));
    expect(await verifyIndicativeRate(rate, sig, CHAIN_ID)).toBe(true);
  });

  it("rejects a tampered rate (sellRate moved after signing)", async () => {
    const sig = await sarrafAccount.signTypedData(buildIndicativeRateTypedData(rate, CHAIN_ID));
    expect(await verifyIndicativeRate({ ...rate, sellRate: "700000" }, sig, CHAIN_ID)).toBe(false);
  });

  it("rejects a signature from a non-Sarraf key", async () => {
    const other = privateKeyToAccount(
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    );
    const sig = await other.signTypedData(buildIndicativeRateTypedData(rate, CHAIN_ID));
    expect(await verifyIndicativeRate(rate, sig, CHAIN_ID)).toBe(false);
  });
});

describe("FirmQuote EIP-712 sign/verify", () => {
  const quote: FirmQuote = {
    sarraf: sarrafAccount.address,
    customer: CUSTOMER,
    direction: "on-ramp",
    usdtAmount: "1000000000",
    fiatAmount: "605000000000",
    validUntil: 1_700_000_180n,
    quoteId: randomQuoteId(),
    nonce: 7n,
  };

  it("verifies a Sarraf-signed firm quote", async () => {
    const sig = await sarrafAccount.signTypedData(buildFirmQuoteTypedData(quote, CHAIN_ID));
    expect(await verifyFirmQuote(quote, sig, CHAIN_ID)).toBe(true);
  });

  it("rejects a firm quote whose amount was changed post-signature", async () => {
    const sig = await sarrafAccount.signTypedData(buildFirmQuoteTypedData(quote, CHAIN_ID));
    expect(await verifyFirmQuote({ ...quote, fiatAmount: "1" }, sig, CHAIN_ID)).toBe(false);
  });
});
