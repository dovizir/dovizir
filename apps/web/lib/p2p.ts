/**
 * Client for the indexer's P2P escrow endpoints (docs/design/fiat-ramp.md §4).
 * The order STATE is on-chain (Escrow.sol) and mirrored by the indexer; these
 * calls serve that mirror plus the off-chain evidence (receipt, chat, bank).
 * Sits alongside lib/ramp.ts; same base URL.
 */
import { INDEXER_URL } from "./indexer";

export type P2pStatus =
  | "OPEN"
  | "MATCHED"
  | "FIAT_CLAIMED"
  | "SETTLED"
  | "REFUNDED"
  | "DISPUTED"
  | "RESOLVED_TAKER"
  | "RESOLVED_MAKER";

export interface P2pOrderRecord {
  orderId: string;
  maker: string;
  taker?: string;
  arbiter: string;
  trancheId: string;
  usdtAmount: string;
  fiat: string;
  fiatAmount: string;
  quoteHash: string;
  receiptHash?: string;
  paymentWindow: number;
  paymentDeadline?: number;
  confirmDeadline?: number;
  status: P2pStatus;
  disputeBy?: string;
  resolvedTo?: "taker" | "maker";
  receiptId?: string;
  makerBank?: string;
  takerBank?: string;
  createdAt: number;
  updatedAt: number;
}

export interface P2pNote {
  id: string;
  orderId: string;
  author: string;
  body: string;
  createdAt: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${INDEXER_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(`p2p ${path}: ${msg}`);
  }
  return (await res.json()) as T;
}

export const p2p = {
  listOrders: (filter: {
    open?: boolean;
    maker?: string;
    taker?: string;
    arbiter?: string;
    status?: P2pStatus;
    fiat?: string;
  }) => {
    const q = new URLSearchParams();
    if (filter.open) q.set("open", "1");
    if (filter.maker) q.set("maker", filter.maker);
    if (filter.taker) q.set("taker", filter.taker);
    if (filter.arbiter) q.set("arbiter", filter.arbiter);
    if (filter.status) q.set("status", filter.status);
    if (filter.fiat) q.set("fiat", filter.fiat);
    const s = q.toString();
    return req<{ orders: P2pOrderRecord[] }>(`/p2p/orders${s ? `?${s}` : ""}`);
  },
  getOrder: (id: string, as?: string) =>
    req<{ order: P2pOrderRecord; notes: P2pNote[] }>(`/p2p/orders/${id}${as ? `?as=${as}` : ""}`),
  setBank: (id: string, body: { as: string; makerBank?: string; takerBank?: string }) =>
    req<{ order: P2pOrderRecord }>(`/p2p/orders/${id}/bank`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  uploadReceipt: (id: string, body: { as: string; mime: string; dataBase64: string }) =>
    req<{ order: P2pOrderRecord; receipt: { id: string; hash: string } }>(
      `/p2p/orders/${id}/receipt`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  addNote: (id: string, body: { as: string; body: string }) =>
    req<{ note: P2pNote }>(`/p2p/orders/${id}/notes`, { method: "POST", body: JSON.stringify(body) }),
  receiptUrl: (receiptId: string, as: string) => `${INDEXER_URL}/p2p/receipts/${receiptId}?as=${as}`,
};
