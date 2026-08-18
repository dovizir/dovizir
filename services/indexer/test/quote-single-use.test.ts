/**
 * A firm quote is single-use.
 *
 * A firm quote is a price the sarraf COMMITTED to, and by design (fiat-ramp §2)
 * a firm price is size-dependent — it was computed for one order of one size.
 * If the same quote can be accepted twice, the sarraf is bound to two fills at
 * a price they offered once, and the customer can wait to see which way the
 * rate moves before deciding how many times to accept. That is a free option
 * written against the sarraf, and it is worth real money in a volatile
 * corridor.
 *
 * Expiry alone does not close it: everything below happens inside the validity
 * window.
 */
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import {
  initRampSchema,
  insertOrder,
  getOrderByQuote,
  type OrderRecord,
} from "../src/ramp-store.js";

const QUOTE = "quote-1";

function db() {
  const d = openDb(":memory:");
  initRampSchema(d);
  return d;
}

const order = (id: string, quoteId = QUOTE): Omit<OrderRecord, "receiptId" | "issueTx" | "redeemTx"> => ({
  id,
  quoteId,
  sarraf: "0xsarraf",
  customer: "0xcustomer",
  direction: "on-ramp",
  fiat: "IRR",
  usdtAmount: "1000000000",
  fiatAmount: "60000000000",
  status: "QUOTED",
  sarrafBank: undefined,
  customerBank: "bank-1",
  createdAt: 1,
  updatedAt: 1,
});

describe("firm quote is single-use", () => {
  it("accepts the first order against a quote", () => {
    const d = db();
    insertOrder(d, order("order-1"));
    expect(getOrderByQuote(d, QUOTE)?.id).toBe("order-1");
  });

  it("refuses a SECOND order against the same quote", () => {
    const d = db();
    insertOrder(d, order("order-1"));
    expect(() => insertOrder(d, order("order-2"))).toThrow();
  });

  it("the refusal is enforced by the database, not only by a prior lookup", () => {
    // Two concurrent accepts can both pass an application-level "does an order
    // exist?" check, so the constraint has to live in the schema.
    const d = db();
    insertOrder(d, order("order-1"));
    let msg = "";
    try {
      insertOrder(d, order("order-2"));
    } catch (e) {
      msg = String(e);
    }
    expect(msg.toUpperCase()).toContain("UNIQUE");
  });

  it("a different quote is unaffected", () => {
    const d = db();
    insertOrder(d, order("order-1"));
    insertOrder(d, order("order-2", "quote-2"));
    expect(getOrderByQuote(d, "quote-2")?.id).toBe("order-2");
  });

  it("reports no order for an unused quote", () => {
    expect(getOrderByQuote(db(), "never-used")).toBeUndefined();
  });
});
