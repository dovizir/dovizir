/** Synthetic event fixtures — no chain required. Mirrors the demo-loop money loop. */
import type { IndexedEvent } from "../src/types.js";

export const SARRAF = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
export const SARRAF_2 = "0x976ea74026e726554db657fa54763abd0c3a0aa9";
export const MEMBER_A = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
export const MEMBER_B = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
export const FUND = "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9";

const TRANCHE = BigInt(SARRAF).toString(10);

let seq = 0;
function ev(
  contract: IndexedEvent["contract"],
  event: string,
  args: Record<string, string>,
  blockTime = 1_000 + seq * 60,
): IndexedEvent {
  const i = seq++;
  return {
    contract,
    event,
    blockNumber: 100 + i,
    blockTime,
    logIndex: 0,
    txHash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
    args,
  };
}

/**
 * Reproduces demo-loop.sh at fixture scale:
 *   deposit 1,000,000e6 → issue 1,000e6 to A → A sends 400e6 to B → B redeems 400e6.
 * Redeem fee = 400e6 * 90 / 10000 = 3_600_000 (3.60 mUSDT).
 */
export function demoLoopEvents(): IndexedEvent[] {
  seq = 0;
  const DEPOSIT = "1000000000000";
  const ISSUE = "1000000000";
  const SEND = "400000000";
  const REDEEM = "400000000";
  const FEE = "3600000";
  return [
    ev("reservePool", "Deposited", { sarraf: SARRAF, amount: DEPOSIT }),
    ev("sarrafRegistry", "Certified", { sarraf: SARRAF }),
    ev("memberRegistry", "MemberAdded", { member: MEMBER_A, sarraf: SARRAF }),
    ev("reservePool", "Issued", { sarraf: SARRAF, to: MEMBER_A, amount: ISSUE }),
    ev("iouToken", "TransferSingle", {
      operator: SARRAF,
      from: "0x0000000000000000000000000000000000000000",
      to: MEMBER_A,
      id: TRANCHE,
      value: ISSUE,
    }),
    ev("memberRegistry", "MemberAdded", { member: MEMBER_B, sarraf: SARRAF }),
    ev("iouToken", "TransferSingle", {
      operator: MEMBER_A,
      from: MEMBER_A,
      to: MEMBER_B,
      id: TRANCHE,
      value: SEND,
    }),
    ev("reservePool", "Redeemed", { sarraf: SARRAF, holder: MEMBER_B, amount: REDEEM, fee: FEE }),
    ev("iouToken", "TransferSingle", {
      operator: MEMBER_B,
      from: MEMBER_B,
      to: "0x0000000000000000000000000000000000000000",
      id: TRANCHE,
      value: REDEEM,
    }),
    ev("insuranceFund", "FeeReceived", { amount: FEE }),
  ];
}
