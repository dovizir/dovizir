/**
 * REST surface for the P2P escrow order book (docs/design/fiat-ramp.md §4).
 * Registered onto the main Fastify app by server.ts.
 *
 * The order STATE is on-chain (Escrow.sol) and mirrored by the sync loop; these
 * routes serve that mirror plus the off-chain evidence the chain never holds:
 *   Book    GET  /p2p/orders          list (?open= / ?maker= / ?taker= / ?arbiter= / ?status= / ?fiat=)
 *           GET  /p2p/orders/:id       one order (+notes +receipt meta; bank redacted unless ?as= party)
 *   Bank    POST /p2p/orders/:id/bank  per-order bank-detail exchange (counterparty-only)
 *   Receipt POST /p2p/orders/:id/receipt  taker uploads the fiat receipt blob → returns its hash
 *                                         (the taker then commits that hash on-chain via claimFiatPaid)
 *           GET  /p2p/receipts/:id     download blob (?as= gated to the two parties + arbiter)
 *   Chat    POST /p2p/orders/:id/notes append a note to the per-order thread (US#5, party-only)
 *
 * Disputes are not a separate endpoint: the dispute STATE is on-chain
 * (raiseDispute/resolve). GET /p2p/orders?status=DISPUTED&arbiter=<sarraf> is the
 * desk dispute inbox; the arbiter reviews the receipt + quote here and resolves
 * on-chain.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "./db.js";
import { getReceiptBlob, insertReceipt } from "./ramp-store.js";
import { isParty, type P2pStatus } from "./p2p.js";
import {
  getP2pOrder,
  insertNote,
  listNotes,
  listP2pOrders,
  patchOrderOffchain,
  type P2pOrderRecord,
} from "./p2p-store.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address");
const p2pStatus = z.enum([
  "OPEN",
  "MATCHED",
  "FIAT_CLAIMED",
  "SETTLED",
  "REFUNDED",
  "DISPUTED",
  "RESOLVED_TAKER",
  "RESOLVED_MAKER",
]);

const bankBody = z.object({
  as: address,
  makerBank: z.string().max(2000).optional(),
  takerBank: z.string().max(2000).optional(),
});

const receiptBody = z.object({
  as: address,
  mime: z.string().regex(/^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/i),
  dataBase64: z.string().min(1),
});

const noteBody = z.object({
  as: address,
  body: z.string().min(1).max(2000),
});

/** Public view of an order (no private bank details). */
function publicView(o: P2pOrderRecord): Omit<P2pOrderRecord, "makerBank" | "takerBank"> {
  const { makerBank: _mb, takerBank: _tb, ...rest } = o;
  return rest;
}

export function registerP2pRoutes(app: FastifyInstance, deps: { db: DB }): void {
  const { db } = deps;
  const now = () => Math.floor(Date.now() / 1000);

  // -------------------------------------------------------------- order book

  app.get("/p2p/orders", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const status = q.status && p2pStatus.safeParse(q.status).success ? (q.status as P2pStatus) : undefined;
    const orders = listP2pOrders(db, {
      maker: q.maker,
      taker: q.taker,
      arbiter: q.arbiter,
      status,
      fiat: q.fiat,
      open: q.open === "1" || q.open === "true",
    });
    // The book is public — never leak bank details from the list view.
    return { orders: orders.map(publicView) };
  });

  app.get("/p2p/orders/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = getP2pOrder(db, id);
    if (!order) return reply.code(404).send({ error: "order not found" });
    const as = (req.query as { as?: string }).as;
    const party = as && /^0x[0-9a-fA-F]{40}$/.test(as) ? isParty(order, as) : false;
    const view = party ? order : publicView(order);
    return { order: view, notes: party ? listNotes(db, id) : [] };
  });

  // ------------------------------------------------------------- bank details

  app.post("/p2p/orders/:id/bank", async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = getP2pOrder(db, id);
    if (!order) return reply.code(404).send({ error: "order not found" });
    const parsed = bankBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!isParty(order, parsed.data.as)) return reply.code(403).send({ error: "not a party to this order" });
    const who = parsed.data.as.toLowerCase();
    const patch: { makerBank?: string; takerBank?: string } = {};
    if (parsed.data.makerBank !== undefined && who === order.maker.toLowerCase()) patch.makerBank = parsed.data.makerBank;
    if (parsed.data.takerBank !== undefined && order.taker && who === order.taker.toLowerCase())
      patch.takerBank = parsed.data.takerBank;
    if (!Object.keys(patch).length) return reply.code(400).send({ error: "nothing to set for this party" });
    return { order: patchOrderOffchain(db, id, patch, now()) };
  });

  // --------------------------------------------------------- receipt evidence

  app.post("/p2p/orders/:id/receipt", async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = getP2pOrder(db, id);
    if (!order) return reply.code(404).send({ error: "order not found" });
    const parsed = receiptBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const who = parsed.data.as.toLowerCase();
    // The taker pays fiat and owns the receipt; upload is only meaningful while
    // the order is matched (before committing the hash on-chain).
    if (!order.taker || who !== order.taker.toLowerCase()) {
      return reply.code(403).send({ error: "receipt must be uploaded by the taker" });
    }
    if (order.status !== "MATCHED" && order.status !== "FIAT_CLAIMED") {
      return reply.code(409).send({ error: `cannot upload a receipt in status ${order.status}` });
    }
    const blob = Buffer.from(parsed.data.dataBase64, "base64");
    if (blob.length === 0) return reply.code(400).send({ error: "empty receipt blob" });
    const hash = "0x" + createHash("sha256").update(blob).digest("hex");
    const receipt = insertReceipt(db, { orderId: id, uploader: who, mime: parsed.data.mime, hash, blob }, now());
    const updated = patchOrderOffchain(db, id, { receiptId: receipt.id }, now());
    // The taker commits `hash` on-chain via Escrow.claimFiatPaid(orderId, hash);
    // the sync loop then records the matching receipt_hash from the event.
    return reply.code(201).send({ order: updated, receipt: { id: receipt.id, hash } });
  });

  app.get("/p2p/receipts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const as = (req.query as { as?: string }).as;
    if (!as || !/^0x[0-9a-fA-F]{40}$/.test(as)) {
      return reply.code(400).send({ error: "?as=<address> required (party-only access)" });
    }
    const blob = getReceiptBlob(db, id);
    if (!blob) return reply.code(404).send({ error: "receipt not found" });
    const meta = db.prepare("SELECT order_id FROM receipts WHERE id = ?").get(id) as
      | { order_id: string }
      | undefined;
    const order = meta ? getP2pOrder(db, meta.order_id) : undefined;
    // Exposed to the two counterparties AND the arbiter (who must judge it).
    if (!order || !isParty(order, as)) return reply.code(403).send({ error: "not a party to this order" });
    return reply.header("content-type", blob.mime).send(blob.blob);
  });

  // -------------------------------------------------------------- chat / notes

  app.post("/p2p/orders/:id/notes", async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = getP2pOrder(db, id);
    if (!order) return reply.code(404).send({ error: "order not found" });
    const parsed = noteBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!isParty(order, parsed.data.as)) return reply.code(403).send({ error: "not a party to this order" });
    const note = insertNote(db, { orderId: id, author: parsed.data.as, body: parsed.data.body }, now());
    return reply.code(201).send({ note });
  });
}
