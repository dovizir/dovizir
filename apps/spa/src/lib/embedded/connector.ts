"use client";

import { createConnector } from "wagmi";
import {
  createPublicClient,
  createWalletClient,
  http,
  numberToHex,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { getRpcUrl } from "@dovizir/sdk";
import {
  getEmbeddedAccount,
  hasEmbeddedWallet,
  peekEmbeddedAddress,
} from "./account";

/**
 * Embedded-wallet wagmi connector. Exposes the locally-held key as an EIP-1193
 * provider so every downstream hook (useAccount / useWriteContract / …) works
 * unchanged — the exact seam wagmi.ts documented. Reads fall through to the RPC
 * transport; writes and signatures are performed locally by the viem account.
 *
 * AA-SEAM: replacing this connector with an ERC-4337 passkey smart-account
 * connector (WebAuthn owner + Pimlico paymaster) leaves the whole app untouched.
 */
function buildProvider(): EIP1193Provider {
  const chain = baseSepolia;
  const rpc = getRpcUrl();
  const pub = createPublicClient({ chain, transport: http(rpc) });
  // Wallet client is built per-write from the CURRENT key. Building the provider
  // never touches key material — critical so wagmi's reconnect (which calls
  // getProvider + eth_accounts) does NOT create a wallet for first-time
  // visitors. Only eth_requestAccounts (explicit connect) creates one.
  const walletFor = () =>
    createWalletClient({ account: getEmbeddedAccount(), chain, transport: http(rpc) });

  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_accounts": {
          const addr = peekEmbeddedAddress();
          return addr ? [addr] : [];
        }
        case "eth_requestAccounts":
          // Explicit connect — create the embedded wallet on first use.
          return [getEmbeddedAccount().address];
        case "eth_chainId":
          return numberToHex(chain.id);
        case "personal_sign": {
          const [message] = params as [Hex, Address];
          return getEmbeddedAccount().signMessage({ message: { raw: message } });
        }
        case "eth_signTypedData_v4": {
          const [, json] = params as [Address, string];
          return getEmbeddedAccount().signTypedData(JSON.parse(json));
        }
        case "eth_sendTransaction": {
          const [tx] = params as [
            { to?: Address; data?: Hex; value?: Hex; gas?: Hex },
          ];
          return walletFor().sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
          });
        }
        default:
          // eth_call, eth_estimateGas, eth_getTransactionCount, receipts, …
          return pub.request({ method: method as never, params: params as never });
      }
    },
    on: () => {},
    removeListener: () => {},
  };
  return provider as unknown as EIP1193Provider;
}

export function embeddedWallet() {
  let provider: EIP1193Provider | undefined;

  return createConnector((config) => ({
    id: "dovizir-embedded",
    name: "Dovizir wallet",
    type: "embedded" as const,

    async connect() {
      const p = (await this.getProvider()) as EIP1193Provider;
      const accounts = (await p.request({
        method: "eth_requestAccounts",
      })) as readonly Address[];
      config.emitter.emit("connect", { accounts, chainId: baseSepolia.id });
      return { accounts, chainId: baseSepolia.id };
    },

    async disconnect() {
      config.emitter.emit("disconnect");
    },

    async getAccounts() {
      const p = (await this.getProvider()) as EIP1193Provider;
      return (await p.request({ method: "eth_accounts" })) as readonly Address[];
    },

    async getChainId() {
      return baseSepolia.id;
    },

    async getProvider() {
      if (!provider) provider = buildProvider();
      return provider;
    },

    // Auto-connect only if a wallet already exists — first-time visitors go
    // through the "Create your wallet" onboarding instead of a silent create.
    async isAuthorized() {
      return hasEmbeddedWallet();
    },

    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {
      config.emitter.emit("disconnect");
    },
  }));
}
