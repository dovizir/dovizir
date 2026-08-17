/**
 * Client for the @dovizir/indexer REST API (the Sarraf desk's data source).
 * Base URL from NEXT_PUBLIC_INDEXER_URL, default http://127.0.0.1:4000.
 */
export const INDEXER_URL =
  process.env.NEXT_PUBLIC_INDEXER_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:4000";

export type CertBand = "certified" | "at-risk" | "below-floor";

export interface SarrafPnl {
  sarraf: string;
  depositVolume: string;
  issuedVolume: string;
  redemptionVolume: string;
  feesGenerated: string;
  feeSplit: { maintenance: string; overseeing: string };
  spreadBps: number;
  redemptionCount: number;
}

export interface SarrafView {
  sarraf: string;
  trancheId: string;
  backing: string;
  outstanding: string;
  coverageBps: number;
  coverageRatio: number;
  creditRateBps: number;
  creditRateAdvisory: true;
  certifiedOnChain: boolean;
  twab: string;
  certificationFloor: string;
  exitFloor: string;
  certBand: CertBand;
  memberCount: number;
  members: string[];
  pnl: SarrafPnl;
  lastEventBlock: number;
}

export interface NetworkStats {
  totalBacking: string;
  totalOutstanding: string;
  totalFees: string;
  claimsPaid: string;
  sarrafCount: number;
  memberCount: number;
  certificationFloor: string;
  coverageBps: number;
}

export interface IndexerHealth {
  ok: boolean;
  chainId: number;
  configured: boolean;
  lastSyncedBlock: string;
  events: number;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${INDEXER_URL}${path}`, { signal });
  if (!res.ok) throw new Error(`indexer ${path}: ${res.status}`);
  return (await res.json()) as T;
}

export const indexer = {
  health: (signal?: AbortSignal) => get<IndexerHealth>("/health", signal),
  stats: (signal?: AbortSignal) => get<NetworkStats>("/stats", signal),
  sarraf: (addr: string, signal?: AbortSignal) =>
    get<SarrafView>(`/sarraf/${addr}`, signal),
  member: (addr: string, signal?: AbortSignal) => get(`/member/${addr}`, signal),
};
