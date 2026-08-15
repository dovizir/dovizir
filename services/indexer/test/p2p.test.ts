import { describe, it, expect } from "vitest";
import {
  arbiterFromTrancheId,
  isLocked,
  isParty,
  isSettled,
  statusFromEvent,
} from "../src/p2p.js";

// A deterministic anvil address used across the demo.
const SARRAF = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const MAKER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const TAKER = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";

describe("arbiterFromTrancheId", () => {
  it("recovers the issuing Sarraf exactly as Escrow.sol derives it", () => {
    // trancheId = uint256(uint160(sarraf)) — as a decimal string on-chain.
    const trancheId = BigInt(SARRAF).toString();
    expect(arbiterFromTrancheId(trancheId)).toBe(SARRAF);
  });

  it("masks to the low 160 bits (ignores any high-bit noise)", () => {
    const base = BigInt(SARRAF);
    const noisy = (1n << 200n) | base; // set a high bit above 160
    expect(arbiterFromTrancheId(noisy)).toBe(SARRAF);
  });

  it("zero-pads short ids to a full 20-byte address", () => {
    expect(arbiterFromTrancheId("1")).toBe("0x0000000000000000000000000000000000000001");
  });
});

describe("statusFromEvent", () => {
  it("maps each escrow event to its status", () => {
    expect(statusFromEvent("OrderCreated")).toBe("OPEN");
    expect(statusFromEvent("OrderFilled")).toBe("MATCHED");
    expect(statusFromEvent("FiatClaimed")).toBe("FIAT_CLAIMED");
    expect(statusFromEvent("OrderSettled")).toBe("SETTLED");
    expect(statusFromEvent("OrderRefunded")).toBe("REFUNDED");
    expect(statusFromEvent("DisputeRaised")).toBe("DISPUTED");
  });

  it("resolves a dispute to the winning side by the toTaker flag", () => {
    expect(statusFromEvent("DisputeResolved", true)).toBe("RESOLVED_TAKER");
    expect(statusFromEvent("DisputeResolved", false)).toBe("RESOLVED_MAKER");
  });

  it("returns undefined for unknown events", () => {
    expect(statusFromEvent("Nonsense")).toBeUndefined();
  });
});

describe("lifecycle predicates", () => {
  it("classifies locked vs settled states", () => {
    expect(isLocked("OPEN")).toBe(true);
    expect(isLocked("DISPUTED")).toBe(true);
    expect(isSettled("SETTLED")).toBe(true);
    expect(isSettled("RESOLVED_MAKER")).toBe(true);
    expect(isLocked("SETTLED")).toBe(false);
    expect(isSettled("MATCHED")).toBe(false);
  });
});

describe("isParty", () => {
  const order = { maker: MAKER, taker: TAKER, arbiter: SARRAF };
  it("admits maker, taker and arbiter (case-insensitive)", () => {
    expect(isParty(order, MAKER.toUpperCase())).toBe(true);
    expect(isParty(order, TAKER)).toBe(true);
    expect(isParty(order, SARRAF)).toBe(true);
  });
  it("rejects an outsider", () => {
    expect(isParty(order, "0x000000000000000000000000000000000000dead")).toBe(false);
  });
  it("handles an unfilled order (no taker yet)", () => {
    expect(isParty({ maker: MAKER, arbiter: SARRAF }, TAKER)).toBe(false);
    expect(isParty({ maker: MAKER, arbiter: SARRAF }, MAKER)).toBe(true);
  });
});
