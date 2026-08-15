/**
 * Direct fiat-ramp order state machine + fiat-verification seam
 * (docs/design/fiat-ramp.md §3). PURE — no IO, no DB — so it is unit-testable
 * with synthetic data and reused by the REST layer.
 *
 * The fiat leg is off-chain and trust-based (§0): the on-chain half is only the
 * IOU mint (on-ramp) or burn/redeem (off-ramp); every other transition is a
 * human attesting a bank transfer against its receipt evidence.
 */

export type RampDirection = "on-ramp" | "off-ramp";

/**
 * On-ramp  (fiat → IOU): OPEN → QUOTED → FIAT_CLAIMED → SETTLED
 * Off-ramp (IOU → fiat): OPEN → QUOTED → IOU_SENT    → SETTLED
 * Either may REJECT from any non-terminal state.
 */
export type OrderStatus =
  | "OPEN"
  | "QUOTED"
  | "FIAT_CLAIMED"
  | "IOU_SENT"
  | "SETTLED"
  | "REJECTED";

export type OrderEventType =
  /** Customer accepts the Sarraf's FirmQuote. */
  | "ACCEPT_QUOTE"
  /** On-ramp: customer uploads the bank receipt for the fiat they paid. */
  | "UPLOAD_RECEIPT"
  /** On-ramp: Sarraf reviewed the receipt and issued IOU on-chain (Issued event). */
  | "ISSUE_CONFIRMED"
  /** Off-ramp: customer redeemed/sent IOU on-chain. */
  | "IOU_SENT"
  /** Off-ramp: Sarraf paid the customer's bank account and uploaded the receipt. */
  | "PAY_FIAT_RECEIPT"
  /** Either side aborts. */
  | "REJECT";

export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set(["SETTLED", "REJECTED"]);

type Table = Record<OrderStatus, Partial<Record<OrderEventType, OrderStatus>>>;

const ON_RAMP: Table = {
  OPEN: { ACCEPT_QUOTE: "QUOTED", REJECT: "REJECTED" },
  QUOTED: { UPLOAD_RECEIPT: "FIAT_CLAIMED", REJECT: "REJECTED" },
  FIAT_CLAIMED: { ISSUE_CONFIRMED: "SETTLED", REJECT: "REJECTED" },
  IOU_SENT: {},
  SETTLED: {},
  REJECTED: {},
};

const OFF_RAMP: Table = {
  OPEN: { ACCEPT_QUOTE: "QUOTED", REJECT: "REJECTED" },
  QUOTED: { IOU_SENT: "IOU_SENT", REJECT: "REJECTED" },
  IOU_SENT: { PAY_FIAT_RECEIPT: "SETTLED", REJECT: "REJECTED" },
  FIAT_CLAIMED: {},
  SETTLED: {},
  REJECTED: {},
};

function table(direction: RampDirection): Table {
  return direction === "on-ramp" ? ON_RAMP : OFF_RAMP;
}

/** The events legal from `status` for `direction`. */
export function allowedEvents(direction: RampDirection, status: OrderStatus): OrderEventType[] {
  return Object.keys(table(direction)[status] ?? {}) as OrderEventType[];
}

export function canApply(
  direction: RampDirection,
  status: OrderStatus,
  event: OrderEventType,
): boolean {
  return table(direction)[status]?.[event] !== undefined;
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly direction: RampDirection,
    public readonly status: OrderStatus,
    public readonly event: OrderEventType,
  ) {
    super(`illegal transition: ${direction} ${status} --(${event})-->`);
    this.name = "IllegalTransitionError";
  }
}

/** Advance the order; throws IllegalTransitionError on an out-of-order event. */
export function applyOrderEvent(
  direction: RampDirection,
  status: OrderStatus,
  event: OrderEventType,
): OrderStatus {
  const next = table(direction)[status]?.[event];
  if (next === undefined) throw new IllegalTransitionError(direction, status, event);
  return next;
}

// --------------------------------------------------------------- IFiatVerifier

export interface FiatVerificationInput {
  direction: RampDirection;
  fiat: string;
  /** Expected fiat amount from the agreed FirmQuote. */
  fiatAmount: string;
  /** sha-256 of the uploaded receipt blob (tamper-evident anchor). */
  receiptHash: string;
  /** Receipt mime type (image/* or application/pdf). */
  receiptMime: string;
}

export interface FiatVerificationResult {
  ok: boolean;
  /** Which verifier decided — "manual" for the PoC human review. */
  method: string;
  note?: string;
}

/**
 * IFiatVerifier — the "regional banking verification" seam (§3). A local-currency
 * bank transfer cannot be checked on-chain, so verification is pluggable:
 *
 *   - ManualFiatVerifier (PoC, below): the confirming party eyeballs the receipt.
 *     `verify()` only asserts an evidence blob exists; the human makes the call.
 *   - FUTURE per-corridor bank-API impls drop in here without touching the order
 *     flow: Iran Shetab/Shaparak card-to-card receipt lookups, Turkish FAST
 *     webhooks, etc. Each corridor keys off `input.fiat` and returns the same
 *     result shape, so the state machine and REST layer never change.
 */
export interface IFiatVerifier {
  verify(input: FiatVerificationInput): Promise<FiatVerificationResult>;
}

/** PoC verifier: evidence must exist; the human confirming the order judges it. */
export class ManualFiatVerifier implements IFiatVerifier {
  async verify(input: FiatVerificationInput): Promise<FiatVerificationResult> {
    const hasEvidence = /^0x[0-9a-fA-F]{64}$/.test(input.receiptHash);
    return {
      ok: hasEvidence,
      method: "manual",
      note: hasEvidence
        ? "receipt on file — confirming party must eyeball it"
        : "no receipt evidence on file",
    };
  }
}
