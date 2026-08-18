/**
 * REST surface for the fiat-ramp product layer (docs/design/fiat-ramp.md §2/§3).
 * Registered onto the main Fastify app by server.ts.
 *
 *   Rates   POST /rates              set the current indicative board rate (signed)
 *           GET  /rates              list current rates (optional ?fiat=)
 *           GET  /rates/:sarraf/:fiat  one current record
 *   RFQ     POST /rfq                customer requests a quote for a specific trade
 *           GET  /rfq                inbox (?sarraf=) / history (?customer=)
 *           GET  /rfq/:id            RFQ + firm quote (once answered)
 *           POST /rfq/:id/quote      Sarraf answers with a signed FirmQuote
 *   Orders  POST /orders            customer accepts a FirmQuote → order (QUOTED)
 *           GET  /orders            ?sarraf= / ?customer= / ?status=
 *           GET  /orders/:id        order + quote + receipt meta  (?as= gated)
 *           POST /orders/:id/bank   per-order bank-detail exchange (counterparty-only)
 *           POST /orders/:id/receipt   upload bank receipt evidence (blob + hash)
 *           POST /orders/:id/iou-sent  off-ramp: customer sent/redeemed IOU on-chain
 *           POST /orders/:id/confirm   on-ramp: Sarraf issued IOU on-chain → SETTLED
 *           POST /orders/:id/reject    abort a non-terminal order
 *   Receipt GET  /receipts/:id       download blob  (?as= gated to counterparty)
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  verifyFirmQuote,
  verifyIndicativeRate,
  type FirmQuote,
  type IndicativeRate,
} from "@dovizir/sdk";
import type { DB } from "./db.js";
import {
  ManualFiatVerifier,
  applyOrderEvent,
  IllegalTransitionError,
  type RampDirection,
} from "./ramp.js";
import {
  getFirmQuote,
  getOrderByQuote,
  getIndicativeRate,
  getOrder,
  getReceiptBlob,
  getRfq,
  insertFirmQuote,
  insertOrder,
  insertReceipt,
  insertRfq,
  listIndicativeRates,
  listOrders,
  listRfqs,
  markRfqQuoted,
  updateOrder,
  upsertIndicativeRate,
} from "./ramp-store.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address");
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/, "expected a 65-byte signature");
const direction = z.enum(["on-ramp", "off-ramp"]);
const fiatCode = z.string().min(1).max(8);

const indicativeBody = z.object({
  rate: z.object({
    sarraf: address,
    fiat: fiatCode,
    buyRate: z.string(),
    sellRate: z.string(),
    minUsdt: z.string(),
    maxUsdt: z.string(),
    effectiveFrom: z.number().int().nonnegative(),
    nonce: z.number().int().nonnegative(),
  }),
  signature,
});

const rfqBody = z.object({
  sarraf: address,
  customer: address,
  direction,
  fiat: fiatCode,
  usdtAmount: z.string().optional(),
  fiatAmount: z.string().optional(),
});

const quoteBody = z.object({
  quote: z.object({
    sarraf: address,
    customer: address,
    direction,
    usdtAmount: z.string(),
    fiatAmount: z.string(),
    validUntil: z.number().int().positive(),
    quoteId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    nonce: z.number().int().nonnegative(),
  }),
  signature,
  sarrafBank: z.string().optional(),
});

const acceptBody = z.object({
  quoteId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  customerBank: z.string().optional(),
});

const bankBody = z.object({
  as: address,
  sarrafBank: z.string().optional(),
  customerBank: z.string().optional(),
});

const receiptBody = z.object({
  as: address,
  mime: z.string().regex(/^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/i),
  dataBase64: z.string().min(1),
});

const iouSentBody = z.object({
  as: address,
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

const confirmBody = z.object({
  as: address,
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});

const rejectBody = z.object({ as: address });

/** Party-scoped access: `as` must be the order's Sarraf or customer. */
function isParty(order: { sarraf: string; customer: string }, who: string): boolean {
  const w = who.toLowerCase();
  return w === order.sarraf || w === order.customer;
}

export function registerRampRoutes(app: FastifyInstance, deps: { db: DB; chainId: number }): void {
  const { db, chainId } = deps;
  const verifier = new ManualFiatVerifier();
  const now = () => Math.floor(Date.now() / 1000);

  // ------------------------------------------------------------- rates

  app.post("/rates", async (req, reply) => {
    const parsed = indicativeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { rate, signature: sig } = parsed.data;
    const typed: IndicativeRate = {
      sarraf: rate.sarraf as `0x${string}`,
      fiat: rate.fiat,
      buyRate: rate.buyRate,
      sellRate: rate.sellRate,
      minUsdt: rate.minUsdt,
      maxUsdt: rate.maxUsdt,
      effectiveFrom: BigInt(rate.effectiveFrom),
      nonce: BigInt(rate.nonce),
    };
    const ok = await verifyIndicativeRate(typed, sig as `0x${string}`, chainId);
    if (!ok) return reply.code(401).send({ error: "signature does not match rate.sarraf" });
    upsertIndicativeRate(db, {
      sarraf: rate.sarraf.toLowerCase(),
      fiat: rate.fiat,
      buyRate: rate.buyRate,
      sellRate: rate.sellRate,
      minUsdt: rate.minUsdt,
      maxUsdt: rate.maxUsdt,
      effectiveFrom: rate.effectiveFrom,
      nonce: rate.nonce,
      signature: sig,
      updatedAt: now(),
    });
    return reply.code(201).send({ ok: true, sarraf: rate.sarraf.toLowerCase(), fiat: rate.fiat });
  });

  app.get("/rates", async (req) => {
    const fiat = (req.query as { fiat?: string }).fiat;
    return { rates: listIndicativeRates(db, fiat) };
  });

  app.get("/rates/:sarraf/:fiat", async (req, reply) => {
    const { sarraf, fiat } = req.params as { sarraf: string; fiat: string };
    if (!/^0x[0-9a-fA-F]{40}$/.test(sarraf)) return reply.code(400).send({ error: "bad sarraf" });
    const rate = getIndicativeRate(db, sarraf, fiat);
    if (!rate) return reply.code(404).send({ error: "no indicative rate for (sarraf, fiat)" });
    return rate;
  });

  // -------------------------------------------------------------- RFQ

  app.post("/rfq", async (req, reply) => {
    const parsed = rfqBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!parsed.data.usdtAmount && !parsed.data.fiatAmount) {
      return reply.code(400).send({ error: "provide usdtAmount or fiatAmount" });
    }
    const rfq = insertRfq(db, parsed.data as never, now());
    return reply.code(201).send(rfq);
  });

  app.get("/rfq", async (req) => {
    const q = req.query as { sarraf?: string; customer?: string };
    return { rfqs: listRfqs(db, { sarraf: q.sarraf, customer: q.customer }) };
  });

  app.get("/rfq/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rfq = getRfq(db, id);
    if (!rfq) return reply.code(404).send({ error: "rfq not found" });
    const quote = rfq.quoteId ? getFirmQuote(db, rfq.quoteId) : undefined;
    return { rfq, quote };
  });

  app.post("/rfq/:id/quote", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rfq = getRfq(db, id);
    if (!rfq) return reply.code(404).send({ error: "rfq not found" });
    const parsed = quoteBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { quote, signature: sig, sarrafBank } = parsed.data;
    if (quote.sarraf.toLowerCase() !== rfq.sarraf || quote.customer.toLowerCase() !== rfq.customer) {
      return reply.code(400).send({ error: "quote parties do not match the RFQ" });
    }
    const typed: FirmQuote = {
      sarraf: quote.sarraf as `0x${string}`,
      customer: quote.customer as `0x${string}`,
      direction: quote.direction as RampDirection,
      usdtAmount: quote.usdtAmount,
      fiatAmount: quote.fiatAmount,
      validUntil: BigInt(quote.validUntil),
      quoteId: quote.quoteId as `0x${string}`,
      nonce: BigInt(quote.nonce),
    };
    const ok = await verifyFirmQuote(typed, sig as `0x${string}`, chainId);
    if (!ok) return reply.code(401).send({ error: "signature does not match quote.sarraf" });
    insertFirmQuote(db, {
      quoteId: quote.quoteId,
      rfqId: id,
      sarraf: rfq.sarraf,
      customer: rfq.customer,
      direction: quote.direction as RampDirection,
      fiat: rfq.fiat,
      usdtAmount: quote.usdtAmount,
      fiatAmount: quote.fiatAmount,
      validUntil: quote.validUntil,
      nonce: quote.nonce,
      signature: sig,
      createdAt: now(),
    });
    markRfqQuoted(db, id, quote.quoteId);
    // Optionally seed the Sarraf's bank details so an accepted on-ramp order can
    // immediately show the customer where to pay.
    return reply.code(201).send({ ok: true, quoteId: quote.quoteId, sarrafBank: sarrafBank ?? null });
  });

  // ------------------------------------------------------------ orders

  app.post("/orders", async (req, reply) => {
    const parsed = acceptBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const quote = getFirmQuote(db, parsed.data.quoteId);
    if (!quote) return reply.code(404).send({ error: "firm quote not found" });
    if (quote.validUntil < now()) return reply.code(410).send({ error: "firm quote expired" });
    // Single-use: a firm price was computed for one order of one size, so a
    // second acceptance would bind the sarraf twice at a price offered once.
    // The unique index is the real guard (it survives concurrent accepts);
    // this turns the collision into a clear 409 instead of a 500.
    const existing = getOrderByQuote(db, quote.quoteId);
    if (existing) {
      return reply.code(409).send({ error: "firm quote already accepted", orderId: existing.id });
    }
    // Born OPEN, the customer's acceptance drives OPEN → QUOTED.
    const status = applyOrderEvent(quote.direction, "OPEN", "ACCEPT_QUOTE");
    const id = crypto.randomUUID();
    const ts = now();
    insertOrder(db, {
      id,
      quoteId: quote.quoteId,
      sarraf: quote.sarraf,
      customer: quote.customer,
      direction: quote.direction,
      fiat: quote.fiat,
      usdtAmount: quote.usdtAmount,
      fiatAmount: quote.fiatAmount,
      status,
      customerBank: parsed.data.customerBank,
      createdAt: ts,
      updatedAt: ts,
    });
    return reply.code(201).send(getOrder(db, id));
  });

  app.get("/orders", async (req) => {
    const q = req.query as { sarraf?: string; customer?: string; status?: string };
    return {
      orders: listOrders(db, {
        sarraf: q.sarraf,
        customer: q.customer,
        status: q.status as never,
      }),
    };
  });

  app.get("/orders/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = getOrder(db, id);
    if (!order) return reply.code(404).send({ error: "order not found" });
    const quote = getFirmQuote(db, order.quoteId);
    return { order, quote };
  });

  app.post("/orders/:id/bank", async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = getOrder(db, id);
    if (!order) return reply.code(404).send({ error: "order not found" });
    const parsed = bankBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!isParty(order, parsed.data.as)) return reply.code(403).send({ error: "not a party to this order" });
    const who = parsed.data.as.toLowerCase();
    const patch: { sarrafBank?: string; customerBank?: string } = {};
    if (parsed.data.sarrafBank !== undefined && who === order.sarraf) patch.sarrafBank = parsed.data.sarrafBank;
    if (parsed.data.customerBank !== undefined && who === order.customer) patch.customerBank = parsed.data.customerBank;
    if (!Object.keys(patch).length) return reply.code(400).send({ error: "nothing to set for this party" });
    return updateOrder(db, id, patch, now());
  });

  app.post("/orders/:id/receipt", async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = getOrder(db, id);
    if (!order) return reply.code(404).send({ error: "order not found" });
    const parsed = receiptBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!isParty(order, parsed.data.as)) return reply.code(403).send({ error: "not a party to this order" });
    const who = parsed.data.as.toLowerCase();

    // On-ramp: customer uploads the fiat receipt. Off-ramp: Sarraf uploads the payout receipt.
    const event = order.direction === "on-ramp" ? "UPLOAD_RECEIPT" : "PAY_FIAT_RECEIPT";
    const expectedUploader = order.direction === "on-ramp" ? order.customer : order.sarraf;
    if (who !== expectedUploader) {
      return reply.code(403).send({ error: `receipt must be uploaded by the ${order.direction === "on-ramp" ? "customer" : "sarraf"}` });
    }
    let nextStatus: string;
    try {
      nextStatus = applyOrderEvent(order.direction, order.status, event);
    } catch (e) {
      if (e instanceof IllegalTransitionError) return reply.code(409).send({ error: e.message });
      throw e;
    }

    const blob = Buffer.from(parsed.data.dataBase64, "base64");
    if (blob.length === 0) return reply.code(400).send({ error: "empty receipt blob" });
    const hash = "0x" + createHash("sha256").update(blob).digest("hex");
    const receipt = insertReceipt(
      db,
      { orderId: id, uploader: who, mime: parsed.data.mime, hash, blob },
      now(),
    );

    // Run the IFiatVerifier seam (manual today; per-corridor bank API later).
    const verdict = await verifier.verify({
      direction: order.direction,
      fiat: order.fiat,
      fiatAmount: order.fiatAmount,
      receiptHash: hash,
      receiptMime: parsed.data.mime,
    });

    const updated = updateOrder(db, id, { status: nextStatus as never, receiptId: receipt.id }, now());
    return reply.code(201).send({ order: updated, receipt: { id: receipt.id, hash }, verification: verdict });
  });

  app.post("/orders/:id/iou-sent", async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = getOrder(db, id);
    if (!order) return reply.code(404).send({ error: "order not found" });
    const parsed = iouSentBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (parsed.data.as.toLowerCase() !== order.customer) {
      return reply.code(403).send({ error: "only the customer reports the IOU send" });
    }
    let nextStatus: string;
    try {
      nextStatus = applyOrderEvent(order.direction, order.status, "IOU_SENT");
    } catch (e) {
      if (e instanceof IllegalTransitionError) return reply.code(409).send({ error: e.message });
      throw e;
    }
    return updateOrder(db, id, { status: nextStatus as never, redeemTx: parsed.data.txHash }, now());
  });

  app.post("/orders/:id/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = getOrder(db, id);
    if (!order) return reply.code(404).send({ error: "order not found" });
    if (order.status === "SETTLED") return { order, alreadySettled: true };
    const parsed = confirmBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (parsed.data.as.toLowerCase() !== order.sarraf) {
      return reply.code(403).send({ error: "only the Sarraf confirms + issues" });
    }
    // Manual fiat verification gate (the Sarraf eyeballed the receipt).
    const verdict = await verifier.verify({
      direction: order.direction,
      fiat: order.fiat,
      fiatAmount: order.fiatAmount,
      receiptHash: order.receiptId ? "0x" + "0".repeat(64) : "",
      receiptMime: "",
    });
    let nextStatus: string;
    try {
      nextStatus = applyOrderEvent(order.direction, order.status, "ISSUE_CONFIRMED");
    } catch (e) {
      if (e instanceof IllegalTransitionError) return reply.code(409).send({ error: e.message });
      throw e;
    }
    const updated = updateOrder(db, id, { status: nextStatus as never, issueTx: parsed.data.txHash }, now());
    return { order: updated, verification: verdict };
  });

  app.post("/orders/:id/reject", async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = getOrder(db, id);
    if (!order) return reply.code(404).send({ error: "order not found" });
    const parsed = rejectBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!isParty(order, parsed.data.as)) return reply.code(403).send({ error: "not a party to this order" });
    let nextStatus: string;
    try {
      nextStatus = applyOrderEvent(order.direction, order.status, "REJECT");
    } catch (e) {
      if (e instanceof IllegalTransitionError) return reply.code(409).send({ error: e.message });
      throw e;
    }
    return updateOrder(db, id, { status: nextStatus as never }, now());
  });

  // --------------------------------------------------------- receipt blob

  app.get("/receipts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const as = (req.query as { as?: string }).as;
    if (!as || !/^0x[0-9a-fA-F]{40}$/.test(as)) {
      return reply.code(400).send({ error: "?as=<address> required (counterparty-only access)" });
    }
    const blob = getReceiptBlob(db, id);
    if (!blob) return reply.code(404).send({ error: "receipt not found" });
    // Receipt is exposed ONLY to the order's two parties.
    const meta = db
      .prepare("SELECT order_id FROM receipts WHERE id = ?")
      .get(id) as { order_id: string } | undefined;
    const order = meta ? getOrder(db, meta.order_id) : undefined;
    if (!order || !isParty(order, as)) return reply.code(403).send({ error: "not a party to this order" });
    return reply.header("content-type", blob.mime).send(blob.blob);
  });
}
