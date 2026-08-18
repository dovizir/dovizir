/**
 * Resolves RPC + contract addresses for the indexer.
 *
 * Precedence (highest first):
 *   1. explicit env vars (RPC_URL, <NAME>_ADDRESS or NEXT_PUBLIC_<NAME>_ADDRESS)
 *   2. packages/contracts/deployments/<chainId>.env (written by Deploy.s.sol —
 *      forge resolves fs paths from the foundry project root, so this is the
 *      single source of truth; DEPLOYMENTS_DIR overrides it)
 *
 * chainId is taken from CHAIN_ID, else read live from the RPC.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type PublicClient } from "viem";
import type { ContractName } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../..");

export interface IndexerConfig {
  rpcUrl: string;
  chainId: number;
  addresses: Record<ContractName | "usdt", `0x${string}`>;
  /** Block to start indexing from (env START_BLOCK, default 0). */
  startBlock: bigint;
  /** getLogs page size. */
  pageSize: bigint;
  /** Reorg safety: re-scan the last N blocks on every poll. */
  reorgDepth: bigint;
  /** Poll interval (ms). */
  pollIntervalMs: number;
  dbPath: string;
  port: number;
}

const ENV_KEYS: Record<ContractName | "usdt", string> = {
  iouToken: "IOU_TOKEN_ADDRESS",
  reservePool: "RESERVE_POOL_ADDRESS",
  insuranceFund: "INSURANCE_FUND_ADDRESS",
  sarrafRegistry: "SARRAF_REGISTRY_ADDRESS",
  memberRegistry: "MEMBER_REGISTRY_ADDRESS",
  noteVault: "NOTE_VAULT_ADDRESS",
  purchaseInsurance: "PURCHASE_INSURANCE_ADDRESS",
  escrow: "ESCROW_ADDRESS",
  usdt: "USDT_ADDRESS",
};

const ZERO = "0x0000000000000000000000000000000000000000" as const;

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** Pick an address for `key` from env → deployments file → zero. */
function pickAddress(key: string, fileEnv: Record<string, string>): `0x${string}` {
  const candidates = [
    process.env[key],
    process.env[`NEXT_PUBLIC_${key}`],
    fileEnv[`NEXT_PUBLIC_${key}`],
    fileEnv[key],
  ];
  for (const c of candidates) {
    if (c && /^0x[0-9a-fA-F]{40}$/.test(c)) return c.toLowerCase() as `0x${string}`;
  }
  return ZERO;
}

export async function loadConfig(): Promise<IndexerConfig> {
  const rpcUrl = process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

  let chainId: number;
  if (process.env.CHAIN_ID) {
    chainId = Number(process.env.CHAIN_ID);
  } else {
    const probe = createPublicClient({ transport: http(rpcUrl) });
    chainId = await probe.getChainId();
  }

  // Deploy.s.sol writes to the foundry project's own deployments dir; read from
  // there directly so no manual copy to the repo root is needed. A repo-root
  // deployments/ copy (if present) is still honoured as a fallback.
  const contractsDeployments = resolve(REPO_ROOT, "packages/contracts/deployments");
  const deploymentsDir =
    process.env.DEPLOYMENTS_DIR ??
    (existsSync(resolve(contractsDeployments, `${chainId}.env`))
      ? contractsDeployments
      : resolve(REPO_ROOT, "deployments"));
  const fileEnv = parseEnvFile(resolve(deploymentsDir, `${chainId}.env`));

  const addresses = {} as Record<ContractName | "usdt", `0x${string}`>;
  for (const [name, key] of Object.entries(ENV_KEYS)) {
    addresses[name as ContractName | "usdt"] = pickAddress(key, fileEnv);
  }

  return {
    rpcUrl,
    chainId,
    addresses,
    startBlock: BigInt(process.env.START_BLOCK ?? "0"),
    pageSize: BigInt(process.env.PAGE_SIZE ?? "5000"),
    reorgDepth: BigInt(process.env.REORG_DEPTH ?? "12"),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? "2000"),
    dbPath: process.env.DB_PATH ?? resolve(HERE, "..", "indexer.db"),
    port: Number(process.env.PORT ?? "4000"),
  };
}

export function makeClient(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl) });
}

export function addressesConfigured(cfg: IndexerConfig): boolean {
  return cfg.addresses.reservePool !== ZERO && cfg.addresses.iouToken !== ZERO;
}
