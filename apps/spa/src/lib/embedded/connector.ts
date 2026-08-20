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
import { createBundlerClient } from "viem/account-abstraction";
import {
  getEmbeddedAccount,
  hasEmbeddedWallet,
  peekEmbeddedAddress,
} from "./account";
// @ts-expect-error — plain-JS config module, tested standalone (aa-config.test.mjs)
import { resolveAaConfig } from "./aa-config.mjs";
import {
  createCredential,
  getSmartAccount,
  peekCredential,
  supportsPasskeys,
} from "./passkey";

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
  // ---- ERC-4337 passkey path (AA-SEAM, now real) -----------------------
  // Active only when a bundler is configured AND the browser does WebAuthn.
  // Everything else falls through to the legacy embedded key, which is the
  // degradation rule: an unset bundler must not strand anyone.
  const aa = resolveAaConfig({
    NEXT_PUBLIC_BUNDLER_URL: process.env.NEXT_PUBLIC_BUNDLER_URL,
    NEXT_PUBLIC_PAYMASTER_URL: process.env.NEXT_PUBLIC_PAYMASTER_URL,
  }) as { enabled: boolean; bundlerUrls: string[]; paymasterUrl?: string };
  const aaActive = () => aa.enabled && supportsPasskeys();

  /** Smart account memo, rebuilt only when the credential changes. */
  let aaAccount: Awaited<ReturnType<typeof getSmartAccount>> | null = null;
  let aaFor: string | null = null;
  async function smartAccount() {
    const cred = peekCredential();
    if (!cred) return null;
    if (!aaAccount || aaFor !== cred.id) {
      aaAccount = await getSmartAccount(cred);
      aaFor = cred.id;
    }
    return aaAccount;
  }
  const bundler = () =>
    createBundlerClient({
      client: pub,
      // First endpoint of the fallback list; rotation on failure arrives with
      // the multi-endpoint transport.
      transport: http(aa.bundlerUrls[0]),
      paymaster: aa.paymasterUrl ? true : undefined,
    });

  const walletFor = () =>
    createWalletClient({ account: getEmbeddedAccount(), chain, transport: http(rpc) });

  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_accounts": {
          if (aaActive() && peekCredential()) {
            const acct = await smartAccount();
            if (acct) return [acct.address];
          }
          const addr = peekEmbeddedAddress();
          return addr ? [addr] : [];
        }
        case "eth_requestAccounts": {
          if (aaActive()) {
            // Explicit connect: the platform passkey prompt (Face ID /
            // fingerprint / PIN). The same credential always derives the same
            // account, so this is also sign-in on a returning device.
            if (!peekCredential()) await createCredential();
            const acct = await smartAccount();
            if (acct) return [acct.address];
          }
          // Legacy embedded wallet — no bundler configured or no WebAuthn.
          return [getEmbeddedAccount().address];
        }
        case "eth_chainId":
          return numberToHex(chain.id);
        case "personal_sign": {
          const [message] = params as [Hex, Address];
          const acct = aaActive() ? await smartAccount() : null;
          if (acct) return acct.signMessage({ message: { raw: message } });
          return getEmbeddedAccount().signMessage({ message: { raw: message } });
        }
        case "eth_signTypedData_v4": {
          const [, json] = params as [Address, string];
          const acct = aaActive() ? await smartAccount() : null;
          if (acct) return acct.signTypedData(JSON.parse(json));
          return getEmbeddedAccount().signTypedData(JSON.parse(json));
        }
        case "eth_sendTransaction": {
          const [tx] = params as [
            { to?: Address; data?: Hex; value?: Hex; gas?: Hex },
          ];
          const acct = aaActive() ? await smartAccount() : null;
          if (acct) {
            // The 4337 path: a UserOperation through the bundler, sponsored
            // when a paymaster is configured. The tx hash handed back is the
            // REAL settlement hash, so receipt-watching code works unchanged.
            const b = bundler();
            const hash = await b.sendUserOperation({
              account: acct,
              calls: [
                {
                  to: tx.to as Address,
                  data: tx.data ?? "0x",
                  value: tx.value ? BigInt(tx.value) : 0n,
                },
              ],
            });
            const receipt = await b.waitForUserOperationReceipt({ hash });
            return receipt.receipt.transactionHash;
          }
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
      // A stored passkey credential counts: a returning device reconnects to
      // the same derived account without a fresh ceremony.
      return hasEmbeddedWallet() || peekCredential() !== null;
    },

    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {
      config.emitter.emit("disconnect");
    },
  }));
}
