/**
 * Demo on-chain driver for offline-notes settlement.
 *
 * NoteVault.reconcile needs a RAW-digest carver signature (not an EIP-191
 * wallet sign) and a fully-onboarded member — neither of which an injected
 * browser wallet can provide in v0. So the demo signs with the embedded anvil
 * persona keys via viem wallet clients (see personas.ts). Guarded to a local
 * chain; this whole module is the AA-SEAM placeholder for smart-account signing.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  getAddresses,
  getRpcUrl,
  iouTokenAbi,
  insuranceFundAbi,
  noteVaultAbi,
  mockUsdtAbi,
  BASE_SEPOLIA_CHAIN_ID,
} from "@dovizir/sdk";
import { carverSig65, onchainInvoiceHash, onchainSpendDigest, onchainTranscript } from "./bridge";
import { CARVER, TRANCHE_ID } from "./personas";

const rpc = () => getRpcUrl();
const chain = {
  id: BASE_SEPOLIA_CHAIN_ID,
  name: "dovizir-local",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc()] } },
} as const;

/** Demo settlement only runs against a local RPC (embedded keys). */
export function isLocalChain(): boolean {
  const url = rpc();
  return url.includes("127.0.0.1") || url.includes("localhost");
}

const publicClient = () => createPublicClient({ chain, transport: http(rpc()) });
const walletFor = (key: Hex) =>
  createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpc()) });

const A = () => getAddresses();

// ------------------------------------------------------------------- reads
export async function readVaultState(root?: Hex) {
  const a = A();
  const pc = publicClient();
  const [locked, cap, reserves] = await Promise.all([
    pc.readContract({ address: a.noteVault, abi: noteVaultAbi, functionName: "lockedOf", args: [CARVER.address] }),
    pc.readContract({ address: a.noteVault, abi: noteVaultAbi, functionName: "capOf", args: [CARVER.address] }),
    pc.readContract({ address: a.insuranceFund, abi: insuranceFundAbi, functionName: "totalReserves" }),
  ]);
  const remaining = root
    ? await pc.readContract({ address: a.noteVault, abi: noteVaultAbi, functionName: "remainingOf", args: [root] })
    : 0n;
  return { locked, cap, reserves, remaining };
}

export async function iouBalance(who: Hex): Promise<bigint> {
  const a = A();
  return publicClient().readContract({
    address: a.iouToken,
    abi: iouTokenAbi,
    functionName: "balanceOf",
    args: [who, TRANCHE_ID],
  });
}

export async function usdtBalance(who: Hex): Promise<bigint> {
  const a = A();
  return publicClient().readContract({
    address: a.usdt,
    abi: mockUsdtAbi,
    functionName: "balanceOf",
    args: [who],
  });
}

export async function isCarverReady(): Promise<{ ready: boolean; iou: bigint; reserves: bigint }> {
  const a = A();
  const pc = publicClient();
  const [iou, reserves] = await Promise.all([
    iouBalance(CARVER.address),
    pc.readContract({ address: a.insuranceFund, abi: insuranceFundAbi, functionName: "totalReserves" }),
  ]);
  return { ready: iou > 0n && reserves > 0n, iou, reserves };
}

// ------------------------------------------------------------------- writes
/** Approve the vault as operator (idempotent) then carve — locks carver IOU. */
export async function carveOnChain(root: Hex, amount: bigint, expiry: number): Promise<Hex> {
  const a = A();
  const w = walletFor(CARVER.privateKey);
  const pc = publicClient();
  const approved = await pc.readContract({
    address: a.iouToken,
    abi: iouTokenAbi,
    functionName: "isApprovedForAll",
    args: [CARVER.address, a.noteVault],
  });
  if (!approved) {
    const h = await w.writeContract({ address: a.iouToken, abi: iouTokenAbi, functionName: "setApprovalForAll", args: [a.noteVault, true] });
    await pc.waitForTransactionReceipt({ hash: h });
  }
  const hash = await w.writeContract({
    address: a.noteVault,
    abi: noteVaultAbi,
    functionName: "carve",
    args: [root, amount, BigInt(expiry)],
  });
  await pc.waitForTransactionReceipt({ hash });
  return hash;
}

export type ReconcileResult =
  | { outcome: "settled"; hash: Hex; serial: Hex; recipient: Hex; amount: bigint }
  | { outcome: "convicted"; hash: Hex; serial: Hex; carver: Hex; victim: Hex };

/**
 * Re-encode an offline spend into the frozen on-chain transcript and settle it.
 * Returns "settled" (NoteReconciled) or "convicted" (DoubleSpendConvicted).
 */
export async function reconcileOnChain(args: {
  root: Hex;
  serial: Hex;
  proof: Hex[];
  recipient: Hex; // on-chain recipient address
  amount: bigint;
  nonce: Hex;
  expiry: number;
}): Promise<ReconcileResult> {
  const a = A();
  const pc = publicClient();
  const invHash = onchainInvoiceHash(args.recipient, args.amount, args.nonce);
  const digest = onchainSpendDigest(args.serial, invHash, args.expiry, args.root);
  const sig = await carverSig65(CARVER.privateKey, digest);
  const transcript = onchainTranscript(args.recipient, args.amount, args.nonce);
  // Relayed by the deployer wallet (reconcile is permissionless; payment is
  // bound to the invoice recipient regardless of relayer).
  const w = walletFor(CARVER.privateKey);
  const hash = await w.writeContract({
    address: a.noteVault,
    abi: noteVaultAbi,
    functionName: "reconcile",
    args: [args.root, args.serial, args.proof, transcript, sig],
  });
  const receipt = await pc.waitForTransactionReceipt({ hash });
  const logs = parseEventLogs({ abi: noteVaultAbi, logs: receipt.logs });
  const convicted = logs.find((l) => l.eventName === "DoubleSpendConvicted");
  if (convicted) {
    const ev = convicted.args as { serial: Hex; carver: Hex; victim: Hex };
    return { outcome: "convicted", hash, serial: ev.serial, carver: ev.carver, victim: ev.victim };
  }
  const reconciled = logs.find((l) => l.eventName === "NoteReconciled");
  const ev = reconciled?.args as { serial: Hex; recipient: Hex; amount: bigint };
  return { outcome: "settled", hash, serial: ev.serial, recipient: ev.recipient, amount: ev.amount };
}
