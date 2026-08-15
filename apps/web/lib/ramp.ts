/**
 * Client for the indexer's fiat-ramp endpoints (docs/design/fiat-ramp.md §2/§3):
 * indicative board rates, RFQ + firm quotes, and on/off-ramp orders + receipts.
 * Sits alongside lib/indexer.ts (the M1 read model); same base URL.
 */
import { INDEXER_URL } from "./indexer";
import type { RampDirection } from "@dovizir/sdk";

export type OrderStatus =
  | "OPEN"
  | "QUOTED"
  | "FIAT_CLAIMED"
  | "IOU_SENT"
  | "SETTLED"
  | "REJECTED";

export interface IndicativeRateRecord {
  sarraf: string;
  fiat: string;
  buyRate: string;
  sellRate: string;
  minUsdt: string;
  maxUsdt: string;
  effectiveFrom: number;
  nonce: number;
  signature: string;
  updatedAt: number;
}

export interface RfqRecord {
  id: string;
  sarraf: string;
  customer: string;
  direction: RampDirection;
  fiat: string;
  usdtAmount?: string;
  fiatAmount?: string;
  status: "pending" | "quoted";
  quoteId?: string;
  createdAt: number;
}

export interface FirmQuoteRecord {
  quoteId: string;
  rfqId: string;
  sarraf: string;
  customer: string;
  direction: RampDirection;
  fiat: string;
  usdtAmount: string;
  fiatAmount: string;
  validUntil: number;
  nonce: number;
  signature: string;
  createdAt: number;
}

export interface OrderRecord {
  id: string;
  quoteId: string;
  sarraf: string;
  customer: string;
  direction: RampDirection;
  fiat: string;
  usdtAmount: string;
  fiatAmount: string;
  status: OrderStatus;
  receiptId?: string;
  issueTx?: string;
  redeemTx?: string;
  sarrafBank?: string;
  customerBank?: string;
  createdAt: number;
  updatedAt: number;
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
    throw new Error(`ramp ${path}: ${msg}`);
  }
  return (await res.json()) as T;
}

export const ramp = {
  // rates
  listRates: (fiat?: string) =>
    req<{ rates: IndicativeRateRecord[] }>(`/rates${fiat ? `?fiat=${fiat}` : ""}`),
  getRate: (sarraf: string, fiat: string) =>
    req<IndicativeRateRecord>(`/rates/${sarraf}/${fiat}`),
  postRate: (body: unknown) =>
    req<{ ok: true }>(`/rates`, { method: "POST", body: JSON.stringify(body) }),

  // rfq
  createRfq: (body: {
    sarraf: string;
    customer: string;
    direction: RampDirection;
    fiat: string;
    usdtAmount?: string;
    fiatAmount?: string;
  }) => req<RfqRecord>(`/rfq`, { method: "POST", body: JSON.stringify(body) }),
  getRfq: (id: string) =>
    req<{ rfq: RfqRecord; quote?: FirmQuoteRecord }>(`/rfq/${id}`),
  listRfqs: (filter: { sarraf?: string; customer?: string }) => {
    const q = new URLSearchParams(filter as Record<string, string>).toString();
    return req<{ rfqs: RfqRecord[] }>(`/rfq${q ? `?${q}` : ""}`);
  },
  answerRfq: (id: string, body: unknown) =>
    req<{ ok: true; quoteId: string }>(`/rfq/${id}/quote`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // orders
  acceptQuote: (quoteId: string, customerBank?: string) =>
    req<OrderRecord>(`/orders`, {
      method: "POST",
      body: JSON.stringify({ quoteId, customerBank }),
    }),
  getOrder: (id: string) =>
    req<{ order: OrderRecord; quote?: FirmQuoteRecord }>(`/orders/${id}`),
  listOrders: (filter: { sarraf?: string; customer?: string; status?: OrderStatus }) => {
    const q = new URLSearchParams(filter as Record<string, string>).toString();
    return req<{ orders: OrderRecord[] }>(`/orders${q ? `?${q}` : ""}`);
  },
  setBank: (id: string, body: { as: string; sarrafBank?: string; customerBank?: string }) =>
    req<OrderRecord>(`/orders/${id}/bank`, { method: "POST", body: JSON.stringify(body) }),
  uploadReceipt: (id: string, body: { as: string; mime: string; dataBase64: string }) =>
    req<{ order: OrderRecord; receipt: { id: string; hash: string }; verification: unknown }>(
      `/orders/${id}/receipt`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  reportIouSent: (id: string, body: { as: string; txHash: string }) =>
    req<OrderRecord>(`/orders/${id}/iou-sent`, { method: "POST", body: JSON.stringify(body) }),
  confirmOrder: (id: string, body: { as: string; txHash?: string }) =>
    req<{ order: OrderRecord }>(`/orders/${id}/confirm`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  rejectOrder: (id: string, as: string) =>
    req<OrderRecord>(`/orders/${id}/reject`, { method: "POST", body: JSON.stringify({ as }) }),
  receiptUrl: (receiptId: string, as: string) =>
    `${INDEXER_URL}/receipts/${receiptId}?as=${as}`,
};

/** Group an integer fiat amount string with thousands separators (LTR). */
export function formatFiat(value: string | number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) return String(value);
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Indicative fiat for a base-unit (6dp) USDT amount at a given fiat/USDT rate. */
export function indicativeFiat(usdtBaseUnits: bigint, rate: string): number {
  const usdt = Number(usdtBaseUnits) / 1e6;
  return Math.round(usdt * Number(rate));
}

/** Read a File as base64 (strips the data: URI prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
